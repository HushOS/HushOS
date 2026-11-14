import Foundation
import HushOSCore
import Observation

/*
 * Approve on another device, as the second step (docs/two-step-design.md 12): the phone that asks
 * and the phone that answers. Everything cryptographic is the core's (`device_approval.rs`), and so
 * is every reply's reading; what is here is the order of things, which is the security of it:
 *
 * - the asking phone commits first, reveals its key and nonce only once another device has fixed
 *   its own value, and only once; it answers the step only with a request that was approved;
 * - the answering phone keeps the commitment as it stood before it opened the request, refuses a
 *   reveal that is not that commitment, and signs only after the code on the other screen was
 *   typed exactly, or its QR code scanned and found to be this very request;
 * - the answering phone's half of the code is its own: made here after it saw the commitment, kept
 *   here, and never taken from the server (`ApprovalMemory`);
 * - turning the method on asks the one device the person chose, and no other, and for that one
 *   request the code runs the other way: the phone that approves signs on a press and then shows
 *   the code, and the phone that asked shows none and takes it typed (`DeviceSetup`). Whoever
 *   turns the method on has then read the approving device's screen, whatever it called itself.
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
        /* A device opened it: the code to type there. Never for a request that turns the method on. */
        case code(String)
        /* A device opened a request that turns the method on: the code is that device's to show, and this phone shows none. */
        case opened
        /* Approved: the step can be answered with this request. Turning the method on, the approval is half of it (`typed`). */
        case approved
        /* Over without an approval. */
        case ended(ApprovalEnded)
    }

    public nonisolated let requestId: String
    /* What a camera on the other device reads, in place of typing the code. None for a request that turns the method on: it is never answered by a scan. */
    public nonisolated let qr: String?
    /* The request turns the method on (the core's `approvalTurnsOn`): its code is shown on the device that approves and typed on this one. */
    public nonisolated let turnsOn: Bool
    /* The step token the request was made for. */
    public nonisolated let token: String
    private let wire: ApprovalWire
    private let step: DeviceStep
    private let nonce: String
    private var revealed = false
    private var code: String?
    /* On the clock nobody can set: the request ends with its token, whatever the phone's date says. */
    private let began: ContinuousClock.Instant = .now

    private init(wire: ApprovalWire, token: String, commitment: String, step: DeviceStep, nonce: String) throws {
        self.wire = wire
        self.token = token
        turnsOn = approvalTurnsOn(purpose: step.purpose)
        qr = turnsOn ? nil : try approvalQr(requestId: step.requestId, commitment: commitment)
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
     * that does not know it yet. `approver` is the device the person chose to approve, when the
     * method is being turned on: only it is shown the request, and the server refuses such a request
     * without one (`device-choice`). A sign-in or a change names none. A refusal is thrown in the
     * server's words (`StepError.refused`).
     */
    public static func start(
        wire: ApprovalWire, stepToken: String, purpose: String, deviceSigningKey: String, name: String, kind: String = "ios", approver: String? = nil
    ) async throws -> DeviceAsk {
        let digest = stepTokenDigest(stepToken: stepToken)
        let nonce = base64urlEncode(bytes: try randomBytes(length: 32))
        let commitment = try deviceStepCommitment(purpose: purpose, tokenDigest: digest, deviceSigningKey: deviceSigningKey, nonce: nonce)
        let body = approvalStartJson(stepToken: stepToken, commitment: commitment, kind: kind, name: name, approverDeviceId: approver)
        let reply = try await wire.send("POST", "/api/auth/approvals", body, nil)
        switch approvalStartReplyRead(status: reply.code, body: reply.text) {
        case .started(let requestId, let userId, _):
            let step = DeviceStep(userId: userId, requestId: requestId, purpose: purpose, tokenDigest: digest, deviceSigningKey: deviceSigningKey)
            return try DeviceAsk(wire: wire, token: stepToken, commitment: commitment, step: step, nonce: nonce)
        case .refused(let refusal, let message):
            throw wire.refused(reply, refusal, message)
        case .lost:
            throw Unanswered()
        }
    }

    /*
     * Asks where the request stands, and reveals once it may. Before a device opened it nothing is
     * revealed: the commitment is all the server and the other device hold. The code is worked out
     * from the first value the other device fixed, and stays that one. For a request that turns
     * the method on it is worked out all the same and never handed out: `typed` checks against it.
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
                if state == .approved { return .approved }
                return turnsOn ? .opened : .code(shown)
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
                case .waiting, .code, .opened: break
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
     * Turning the method on: what the person typed here, as it is written ("47 river"), when it is
     * exactly the code this phone worked out for the request, the one the approving device shows
     * once it approved. Nil for anything else, for any other request, and until a device opened
     * this one. The check is the core's (`approvalCodeTyped`); the server makes it again.
     */
    public func typed(_ typed: String) -> String? {
        guard turnsOn, let code else { return nil }
        return approvalCodeTyped(code: code, typed: typed)
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

public extension DeviceAsk {
    /* What a request is made from: every Ask again makes another from the same one, the chosen device included. */
    struct Request: Sendable {
        public let wire: ApprovalWire
        public let token: String
        /* `login`, a change's purpose, or `device-approval`. */
        public let purpose: String
        /* This phone's device key, base64url. */
        public let key: String
        /* Turning the method on: the device the person chose to approve. Nil for a sign-in or a change. */
        public let approver: String?

        public init(wire: ApprovalWire, token: String, purpose: String, key: String, approver: String? = nil) {
            self.wire = wire
            self.token = token
            self.purpose = purpose
            self.key = key
            self.approver = approver
        }

        /* `name`: what this phone calls itself. */
        public func start(name: String) async throws -> DeviceAsk {
            try await DeviceAsk.start(wire: wire, stepToken: token, purpose: purpose, deviceSigningKey: key, name: name, approver: approver)
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
    /* The server answered this phone's open with another value than this phone made: ended, nothing signed. */
    case changed
    /* The list says this phone opened the request, and this run of the app holds no value for it: ended, nothing signed. */
    case restarted

    public var errorDescription: String? {
        switch self {
        case .mismatch: StepWords.approvalMismatch
        case .wrongCode: StepWords.approvalWrongCode
        case .over(let message): message
        case .changed: StepWords.approvalChanged
        case .restarted: StepWords.approvalRestarted
        }
    }
}

/*
 * What this run of the app opened, by request: the 32 bytes it made, and the request as it stood
 * before it posted them. In memory only, and the account's: the inbox drops it with the session.
 *
 * The value is this phone's half of the code. It has to be one this phone made after the
 * commitment was fixed: a value the server chose, after seeing the commitment, could be chosen to
 * steer the code. So nothing here is ever filled from a reply.
 */
public final class ApprovalMemory: @unchecked Sendable {
    struct Opened: Equatable {
        let value: String
        /* The request as it was listed before this phone opened it: its purpose, token digest and commitment. */
        let prompt: ApprovalPrompt
    }

    private let lock = NSLock()
    private var opened: [String: Opened] = [:]

    public init() {}

    func held(_ id: String) -> Opened? { lock.withLock { opened[id] } }
    func keep(_ made: Opened, for id: String) { lock.withLock { opened[id] = made } }
    func forget(_ id: String) { lock.withLock { opened[id] = nil } }
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
    /* "The other device asked for this device to approve.", when it named this one; nil otherwise. */
    public nonisolated let chosenLine: String?
    /*
     * The request turns the method on (the core's `approvalTurnsOn`, over the purpose as first
     * listed, which the commitment binds). Then nothing is typed or scanned here: this phone signs
     * on the person's press and hands back the code for them to type on the device that asked.
     */
    public nonisolated let turnsOn: Bool
    /* The request as it stood before this phone opened it: as remembered, if this run opened it before. */
    private let asked: ApprovalPrompt
    /* The list said a device had opened it already when this was made. */
    private let listedOpened: Bool
    private let wire: ApprovalWire
    private let userId: String
    private let seed: Data
    private let memory: ApprovalMemory
    /* This phone's own value, once it opened the request: the one it made, never one a reply carried. */
    private var approverKey: String?
    /* Ended from here because something did not match: nothing more is opened, looked for or signed. */
    private var refused: ApprovalProblem?
    /* The code this phone expects, and what it signs, once the other device revealed what it committed to. */
    private var ready: (code: String, step: DeviceStep)?
    /* The other screen's QR code was read, and it was this request: the commitment was the check, and no code is typed. */
    public private(set) var scanned = false

    /*
     * `prompt`: the request as listed. `userId` and `seed`: this phone's own account id and device
     * key. `memory`: what this run of the app opened; a request it opened before is answered as it
     * stood then, whatever is listed now.
     */
    public init(prompt: ApprovalPrompt, wire: ApprovalWire, userId: String, seed: Data, memory: ApprovalMemory) {
        let before = memory.held(prompt.id)?.prompt ?? prompt
        id = prompt.id
        // A name the server does not vouch for is said as the asking device's own words.
        asks = approvalAsks(purpose: before.purpose, deviceName: before.deviceName, selfNamed: before.selfNamed, location: before.location)
        chosenLine = before.chosen ? StepWords.approvalChosen : nil
        turnsOn = approvalTurnsOn(purpose: before.purpose)
        asked = before
        listedOpened = prompt.approverKey != nil
        self.wire = wire
        self.userId = userId
        self.seed = seed
        self.memory = memory
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
     *
     * A request that turns the method on is never answered by a scan, whatever was read: a scan is
     * this phone's own word that it saw the other screen, and this phone is the one in doubt.
     * False, with nothing opened, nothing marked as scanned and nothing sent.
     */
    public func open(scanned text: String) async throws -> Bool {
        guard !turnsOn, let read = approvalQrRead(text: text) else { return false }
        if let refused { throw refused }
        guard read.requestId == asked.id, read.commitment == asked.commitment else { throw await refuse(.mismatch) }
        try await open()
        scanned = true
        return true
    }

    /* Ends the request because something did not match (`mismatch`, not a failed step), and keeps it ended here. */
    private func refuse(_ problem: ApprovalProblem) async -> ApprovalProblem {
        refused = problem
        memory.forget(id)
        _ = try? await post("deny", approvalDenyJson(reason: Ending.mismatch.rawValue))
        return problem
    }

    /*
     * Opens the request: this phone's own 32 fresh bytes go in, and only then does the other device
     * reveal. The bytes are made here and remembered before they go, with the request as it stood;
     * opening again in the same run sends the same ones.
     *
     * The server's reply echoes the value the request was opened with. Anything but the one this
     * phone sent means the server chose it, after seeing the commitment: the request is ended and
     * nothing is typed or signed. So is a request the list says was already opened when this run of
     * the app holds no value for it (the app was restarted since): nothing is opened again, and no
     * value is taken from the list.
     */
    public func open() async throws {
        if let refused { throw refused }
        guard approverKey == nil else { return }
        let before = memory.held(id)
        if before == nil, listedOpened { throw await refuse(.restarted) }
        let mine = try before?.value ?? base64urlEncode(bytes: randomBytes(length: 32))
        // Before it goes: a reply that never arrives leaves this phone holding what it sent, to send again.
        memory.keep(ApprovalMemory.Opened(value: mine, prompt: asked), for: id)
        guard case .done(let echoed?) = try await post("open", approvalOpenJson(ephemeralKey: mine)) else { throw Unanswered() }
        guard echoed == mine else { throw await refuse(.changed) }
        approverKey = mine
    }

    /*
     * One look for what the other device revealed. False while it has not. What it revealed must be
     * what it committed to before this phone opened the request, for the purpose and token listed
     * then: if it is not, no honest device is on the other side, the request is ended (`mismatch`)
     * and nothing is ever signed for it. A request that left the list is over.
     */
    public func revealed() async throws -> Bool {
        if let refused { throw refused }
        if ready != nil { return true }
        guard let approverKey else { return false }
        guard let now = try await DeviceApprovals.listed(wire: wire).first(where: { $0.id == id }) else { throw ApprovalProblem.over(StepWords.approvalOver) }
        guard let key = now.revealKey, let nonce = now.revealNonce else { return false }
        let step = DeviceStep(userId: userId, requestId: id, purpose: asked.purpose, tokenDigest: asked.tokenDigest, deviceSigningKey: key)
        do {
            ready = (try approvalCodeExpected(step: step, commitment: asked.commitment, approverKey: approverKey, nonce: nonce), step)
            return true
        } catch {
            throw await refuse(.mismatch)
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

    /* What stands between the press of Approve and the signature. */
    private enum Check {
        /* The code on the other screen, typed here exactly. */
        case typed
        /* That screen's QR code was read, and it was this very request: nothing is typed. */
        case scanned
        /* Turning the method on: nothing is checked here. The code is shown afterwards, and checked where it is typed. */
        case shownAfter
    }

    /* Decided here and nowhere else. Nothing typed is enough only for these two; `scanned` is never set for a request that turns the method on. */
    private var check: Check { turnsOn ? .shownAfter : scanned ? .scanned : .typed }

    /*
     * Approves. After a scan the commitment was the check and nothing is typed (`typed` nil).
     * Otherwise only the exact code is approved: anything else ends the request (`wrong-code`),
     * and nothing is signed. The signature is this phone's device key's, over the statement that
     * names this phone's own account, the request, its purpose, its token and the asking device.
     *
     * A request that turns the method on is signed on the press, with nothing typed, and its code
     * comes back: the person types it on the device that asked. Nil back for every other request.
     */
    @discardableResult
    public func approve(typed: String?) async throws -> String? {
        if let refused { throw refused }
        guard let ready else { throw Unanswered() }
        switch check {
        case .shownAfter:
            break
        case .scanned where typed == nil:
            break
        case .scanned, .typed:
            guard let typed, approvalCodeNormalize(typed: typed) == ready.code else {
                try? await end(.wrongCode)
                throw ApprovalProblem.wrongCode
            }
        }
        let signature = try deviceStepSign(seed: seed, step: ready.step)
        guard case .done = try await post("approve", approvalApproveJson(signature: signature)) else { throw StepError.lost(StepWords.lostChange) }
        return turnsOn ? ready.code : nil
    }

    /*
     * Opens, then waits for the reveal, for the sheet that has nothing to fall back to (a request
     * that turns the method on offers no scan and no field). An open that got no answer is made
     * again, as a look is: it sends the same value every time.
     */
    public func openAndAwaitReveal(every interval: Duration = .seconds(2)) async throws {
        let began = ContinuousClock.now
        while true {
            try Task.checkCancellation()
            do {
                try await open()
                break
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
        try await awaitReveal(every: interval)
    }

    /* Deny, or This wasn’t me: the request ends, and is counted as a failed step. */
    public func end(_ why: Ending) async throws {
        guard case .done = try await post("deny", approvalDenyJson(reason: why.rawValue)) else { throw StepError.lost(StepWords.lostChange) }
    }
}

/*
 * The requests this phone may answer now, after its own limit of five a day for each class
 * (`PromptLimit`). The app reads it when it comes to the front, every five seconds while Account is
 * on screen, and when a push arrives; Home's banner and Devices' rows show `prompts`.
 *
 * - It asks only the approvals routes. Whether the server lets accounts turn two-step sign-in on
 *   (the settings route's 501) is nothing to it: an account that already has the step is still
 *   asked for it, so its requests are still listed and answered.
 * - Everything it holds is one session's: the prompts, the request being answered, each request as
 *   first listed, and what this run opened. All of it goes the moment another session is seen,
 *   before anything else is decided, so nothing of the last account is ever shown under the next.
 */
@Observable
@MainActor
public final class ApprovalInbox {
    public static let shared = ApprovalInbox()

    /* A request being answered: the app shows its sheet. */
    public struct Answering: Identifiable, Sendable {
        public let id: String
        public let flow: ApprovalAnswering
    }

    /* Where the inbox reads the session, this phone's device key for it, and the server. Tests put their own here. */
    public struct Source: Sendable {
        let session: @Sendable () -> SharedKeychain.Session?
        let identity: @Sendable (SharedKeychain.Session) -> SharedKeychain.DeviceIdentity?
        let wire: @Sendable (SharedKeychain.Session) -> ApprovalWire
        let limit: PromptLimit

        public static let stored = Source(session: { SharedKeychain.session }, identity: { DeviceApprovals.identity(for: $0) }, wire: { .signedIn($0) }, limit: .stored)
    }

    public private(set) var prompts: [ApprovalPrompt] = []
    public var answering: Answering?
    @ObservationIgnored private let source: Source
    /* The session a look is out for, by its tag: one look at a time for each. */
    @ObservationIgnored private var loading: String?
    /* The session everything here is for. */
    @ObservationIgnored private var owner: String?
    /* Each request as it was first listed, before this phone opened it: what its reveal is checked against. */
    @ObservationIgnored private var first: [String: ApprovalPrompt] = [:]
    @ObservationIgnored private var flows: [String: ApprovalAnswering] = [:]
    /* What this run opened, for the session in `owner`. */
    @ObservationIgnored private var memory = ApprovalMemory()

    public init(source: Source = .stored) { self.source = source }

    /* The session the phone holds now, having dropped everything held for any other. Nil with nobody signed in, or with no device key for the account: such a phone approves nothing, and asks nothing. */
    private func current() -> SharedKeychain.Session? {
        guard let session = source.session(), source.identity(session) != nil else {
            clear()
            return nil
        }
        if owner != session.tag {
            clear()
            owner = session.tag
        }
        return session
    }

    public func load() async {
        // First, and whatever else is going on: a look still out for the last session must not keep its prompts on screen.
        guard let session = current() else { return }
        guard loading != session.tag else { return }
        loading = session.tag
        defer { if loading == session.tag { loading = nil } }
        // Kept as it was when the server can't be asked: the next look asks again.
        guard let listed = try? await DeviceApprovals.listed(wire: source.wire(session)) else { return }
        // The answer is for the session it was asked under. Another one since: it is shown nowhere and counted nowhere.
        guard owner == session.tag, source.session()?.tag == session.tag else { return }
        let shown = source.limit.shown(listed)
        for asked in shown where first[asked.id] == nil { first[asked.id] = asked }
        let live = Set(shown.map(\.id)).union(answering.map { [$0.id] } ?? [])
        first = first.filter { live.contains($0.key) }
        flows = flows.filter { live.contains($0.key) }
        prompts = shown
    }

    /* Answer: the request's sheet, over whatever is on screen. Only for a request listed under the session the phone holds now. */
    public func answer(_ asked: ApprovalPrompt) {
        guard let session = current(), prompts.contains(where: { $0.id == asked.id }), let identity = source.identity(session),
              let seed = try? base64urlDecode(value: identity.seed) else { return }
        let flow = flows[asked.id] ?? ApprovalAnswering(prompt: first[asked.id] ?? asked, wire: source.wire(session), userId: identity.userId, seed: seed, memory: memory)
        flows[asked.id] = flow
        answering = Answering(id: asked.id, flow: flow)
    }

    /* Approved, denied or over: it leaves the list at once, without waiting for the next look. */
    public func finished(_ id: String) {
        prompts.removeAll { $0.id == id }
        first[id] = nil
        flows[id] = nil
        memory.forget(id)
    }

    /* Whether a request being answered is still the signed-in session's: false once the phone holds another session, or none. */
    public func holds(_ id: String) -> Bool {
        guard let owner, source.session()?.tag == owner else { return false }
        return flows[id] != nil
    }

    private func clear() {
        // Not written when already empty: every look of a signed-out phone would redraw whatever shows the list.
        if !prompts.isEmpty { prompts = [] }
        if answering != nil { answering = nil }
        first = [:]
        flows = [:]
        owner = nil
        // A new one, never the old one emptied: a request of the last session still in flight keeps writing to its own.
        memory = ApprovalMemory()
    }
}

/*
 * The answer sheet, as it follows one request: what it shows, and what it lets the person do
 * meanwhile. The checks are `ApprovalAnswering`'s; what is here is the sheet's own order:
 *
 * - Waiting for the other device is not sending. The wait for what it reveals can last minutes
 *   and never holds the sheet: Cancel, a swipe, Deny and This wasn’t me all work through it. Only
 *   an approval or an ending that is out (`sending`) holds it, until its answer is in.
 * - Cancel or a swipe only closes the sheet, in every phase: nothing is sent, and the request
 *   stays in the list, to be answered again or to run out (an unanswered one is counted then, by
 *   the server). Only Deny and This wasn’t me end a request: someone backing out of their own
 *   approval has not refused anything, and must not set off a failed-step notice.
 * - A request that turns the method on is opened as the sheet comes up, offers no scan and no
 *   field, and is approved on a press once the other device revealed. Its code is then shown here
 *   until Done: nothing closes the sheet meanwhile, and nothing says the request is over.
 */
@Observable
@MainActor
public final class ApprovalAnswer {
    public enum Phase: Sendable, Equatable {
        /* Scan the other screen, or type its code. Never for a request that turns the method on. */
        case choose
        case scanning
        /* Opened, or being opened: looking for what the other device reveals. */
        case waiting
        /* The other device revealed: its code is typed here. */
        case typing
        /* Nothing to type: after a scan of this very request, or for a request that turns the method on. */
        case confirm
        /* Turning the method on, approved: the code for the person to type on the device that asked. */
        case shown(String)
    }

    /* What the app does around the sheet: the notice it shows, and the list the request leaves. */
    public struct Around: Sendable {
        let say: @MainActor @Sendable (_ words: String, _ important: Bool) -> Void
        let finished: @MainActor @Sendable (_ id: String) -> Void

        public init(
            say: @escaping @MainActor @Sendable (String, Bool) -> Void,
            finished: @escaping @MainActor @Sendable (String) -> Void = { ApprovalInbox.shared.finished($0) }
        ) {
            self.say = say
            self.finished = finished
        }
    }

    public nonisolated let flow: ApprovalAnswering
    public nonisolated let turnsOn: Bool
    public private(set) var phase: Phase
    /* An approval or an ending is out. This alone holds the sheet; waiting for the other device never does. */
    public private(set) var sending = false
    public private(set) var error = ""
    /* Over: the sheet goes. */
    public private(set) var closed = false
    @ObservationIgnored private let around: Around
    @ObservationIgnored private let interval: Duration
    @ObservationIgnored private var work: Task<Void, Never>?
    /* What `work` was started as: a task let go changes nothing afterwards. */
    @ObservationIgnored private var turn = 0

    public init(flow: ApprovalAnswering, around: Around, every interval: Duration = .seconds(2)) {
        self.flow = flow
        self.around = around
        self.interval = interval
        turnsOn = flow.turnsOn
        phase = flow.turnsOn ? .waiting : .choose
    }

    /* Whether Cancel, a swipe, Deny and This wasn’t me are held back: only over a request that is out. */
    public var held: Bool { sending }

    /* The sheet came up. A request that turns the method on has nothing to choose: it is opened now, and the reveal waited for. */
    public func appeared() {
        guard turnsOn, phase == .waiting, work == nil, !closed else { return }
        wait { [flow, interval] in
            try await flow.openAndAwaitReveal(every: interval)
            return .confirm
        }
    }

    /* Scan the code. Not for a request that turns the method on. */
    public func scan() {
        guard !sending, !turnsOn, phase == .choose else { return }
        error = ""
        phase = .scanning
    }

    /* Type the code: the request is opened, and the field appears once the other device has revealed what it committed to. */
    public func type() {
        guard !sending, !turnsOn, phase == .choose else { return }
        wait { [flow, interval] in
            try await flow.open()
            try await flow.awaitReveal(every: interval)
            return .typing
        }
    }

    /* What the camera read. Anything that is not an approval's code is passed over; this request's own opens it. */
    public func scanned(_ text: String) {
        // Another QR code in view is not looked at twice, and holds nothing up.
        guard !sending, !turnsOn, phase == .scanning, approvalQrRead(text: text) != nil else { return }
        wait { [flow, interval] in
            // Not this request's after all: the camera goes on looking.
            guard try await flow.open(scanned: text) else { return .scanning }
            try await flow.awaitReveal(every: interval)
            return .confirm
        }
    }

    /* The wait for the other device, and what the sheet shows after it. Not `sending`: it may take minutes, and holds nothing. */
    private func wait(_ opened: @escaping @Sendable () async throws -> Phase) {
        error = ""
        phase = .waiting
        turn += 1
        let mine = turn
        work = Task {
            do {
                let next = try await opened()
                guard turn == mine else { return }
                phase = next
            } catch {
                guard turn == mine else { return }
                failed(error)
            }
        }
    }

    /* The field changed: what was said about the last try no longer applies. */
    public func edited() { error = "" }

    /*
     * Approve. `typed` is what the field holds, and counts only while the field is up; with
     * nothing to type (`confirm`) nothing is passed, and `ApprovalAnswering` decides whether that
     * is enough. A request that turns the method on comes back with its code, which stays up.
     */
    public func approve(typed: String = "") {
        guard !sending, phase == .typing || phase == .confirm else { return }
        let sent = phase == .typing ? typed : nil
        send({ [flow] in try await flow.approve(typed: sent) }) { [self] code in
            guard let code else { return close(StepWords.approved) }
            // Approved: it leaves the list now, and the code stays here until Done.
            around.finished(flow.id)
            phase = .shown(code)
        }
    }

    /* Deny, or This wasn’t me, at any point before the request is approved. */
    public func end(_ why: ApprovalAnswering.Ending) {
        guard !sending, !closed else { return }
        if case .shown = phase { return }
        send({ [flow] in try await flow.end(why) }) { [self] in close(StepWords.denied) }
    }

    /* A request that is out: whatever was waiting is let go, and the sheet is held until the answer is in and `then` has heard it. */
    private func send<Got: Sendable>(_ request: @escaping @Sendable () async throws -> Got, then: @escaping @MainActor (Got) -> Void) {
        sending = true
        error = ""
        work?.cancel()
        turn += 1
        let mine = turn
        work = Task {
            do {
                let got = try await request()
                guard turn == mine else { return }
                then(got)
            } catch {
                guard turn == mine else { return }
                failed(error)
            }
            sending = false
        }
    }

    /* Done, under the code. */
    public func done() {
        guard case .shown = phase else { return }
        closed = true
    }

    /*
     * Cancel, or a swipe. False when held: an approval or an ending is out, and everything stays.
     * Otherwise the sheet closes and nothing is sent, waiting or not: the request stays in the
     * list. Ending it is Deny's and This wasn’t me's alone.
     */
    @discardableResult
    public func cancel() -> Bool {
        guard !sending else { return false }
        guard !closed else { return true }
        turn += 1
        work?.cancel()
        work = nil
        closed = true
        return true
    }

    /* The sheet went away, by a swipe or because its session ended. A request that is out is let go with it. */
    public func gone() {
        guard !cancel() else { return }
        turn += 1
        work?.cancel()
        closed = true
    }

    private func close(_ said: String, important: Bool = false) {
        around.say(said, important)
        around.finished(flow.id)
        closed = true
    }

    /* A request that is over, or that did not match, closes with why. Anything else stays, to be tried again. */
    private func failed(_ error: Error) {
        if ErrorWords.isCancellation(error) { return }
        if let problem = error as? ApprovalProblem {
            close(problem.errorDescription ?? ErrorWords.generic, important: true)
            return
        }
        // An ended session is said by the app as everywhere; nothing of this account's is left to answer.
        if endsSession(error) { closed = true; return }
        if !turnsOn, phase == .waiting || phase == .scanning { phase = .choose }
        self.error = ErrorWords.say(error) ?? ""
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
     * Confirms it with the request another device approved and the code that device shows, as the
     * person typed it here and `DeviceAsk.typed` wrote it ("47 river"); the server works the code
     * out again (a wrong one is 409 `device-code`, in its own words, and ends the request).
     * `StepError.refused(.pending, …)` until a device approved: nothing changed. Only the server's
     * own two answers say it is on: the backup codes when this turned the step on (`turnedOn`), or
     * `replaced` never: `added` beside other methods.
     */
    static func confirmDevice(_ started: DeviceEnrolment, requestId: String, code: String) async throws -> DeviceConfirmed {
        let json = deviceConfirmJson(token: started.token, requestId: requestId, code: code)
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

/*
 * Turning on Approve on another device, as its sheet follows it (docs/two-step-design.md 12,
 * "Turning it on first"). What is here is what must not go wrong on that screen:
 *
 * - The person says which of their devices is to approve. With no method yet every signed-in
 *   device looks alike to the server, one someone else opened with the password among them, so a
 *   request any of them could answer would let that one answer first. Nothing is sent, not the
 *   pending method and not a request, until a device is chosen; every request names it.
 * - No device is ever chosen for them, even when there is one. The list is the devices' own
 *   words: someone with the password can sign in as "Maya’s iPhone" and be its only entry.
 * - The approval alone turns nothing on, and sends nothing. The device that approved then shows a
 *   code; the person types it here, it is checked against the code this phone worked out itself
 *   (`DeviceAsk.typed`), and only then is the confirmation sent, with it. A device they are not
 *   holding shows them nothing to type. One try: a code that is not it drops the request here,
 *   and Ask again asks the same device afresh.
 * - The confirmation is marked as out before it goes, and what it answers is kept here, not in a
 *   view: the backup codes are shown once, and a sheet closed over a confirmation the server took
 *   would turn the step on with nobody ever seeing them. The sheet does not close while it is out,
 *   nor while the codes are up, except by their own Done.
 * - Turning the step on offers to remove the other devices, ticked. The codes come first; the
 *   removal runs behind them and never costs them. The device that approved stays: it is the method.
 */
@Observable
@MainActor
public final class DeviceSetup {
    public enum Removing: Sendable, Equatable { case no, running, failed }

    /* The confirm button was pressed with no device chosen: nothing went out. */
    public struct Unchosen: Error, WordedError, Equatable {
        public var errorDescription: String? { StepWords.chooseApprover }
    }

    /* What was typed is not the code the approving device shows: the request was dropped here, and nothing was sent. */
    public struct WrongCode: Error, WordedError, Equatable {
        public var errorDescription: String? { StepWords.turnOnWrongCode }
    }

    /* What the confirmation did. */
    public enum Confirmed: Sendable, Equatable {
        /* The step is on: `codes` holds the backup codes until Done. */
        case turnedOn
        /* Added beside the account's other methods. */
        case added
    }

    public typealias Start = @Sendable (_ password: String, _ twoStep: StepAnswer?) async throws -> DeviceEnrolment
    public typealias Confirm = @Sendable (_ started: DeviceEnrolment, _ requestId: String, _ code: String) async throws -> TwoStep.DeviceConfirmed
    public typealias Remove = @Sendable (_ password: String, _ keep: String) async throws -> Void

    /* The account has no method yet: this turns the step on. */
    public let first: Bool
    /* The devices that could approve, as the settings listed them. */
    public let approvers: [TwoStepStatus.Approver]
    public private(set) var chosenId: String?
    /* "Remove my other devices": offered, ticked, when this turns the step on. */
    public var removeOthers = true
    /* The pending method, and the step token its one approval runs from: good for ten minutes. */
    public private(set) var started: DeviceEnrolment?
    /* The request the chosen device approved: its code is asked for now. Nothing was sent on the approval. */
    @ObservationIgnored private var approved: DeviceAsk?
    /* The chosen device approved, and the code it shows has not been typed here yet: the sheet shows the field. */
    public private(set) var awaitsCode = false
    /* The confirmation is out: nothing closes the sheet until it is answered. */
    public private(set) var confirming = false
    /* The backup codes, shown once: held until Done. */
    public private(set) var codes: [String]?
    public private(set) var removing = Removing.no

    public init(first: Bool, approvers: [TwoStepStatus.Approver]) {
        self.first = first
        self.approvers = approvers
        // Never chosen for the person, even when there is one: the names are the devices' own words.
        chosenId = nil
    }

    public var chosen: TwoStepStatus.Approver? { approvers.first { $0.id == chosenId } }

    /* The choice is made before anything is sent, and stands for everything sent after. */
    public func choose(_ id: String) {
        guard started == nil, !confirming, codes == nil, approvers.contains(where: { $0.id == id }) else { return }
        chosenId = id
    }

    /* Whether Cancel, a swipe or Back may close the sheet: not over a confirmation that is out, and not over codes that were not yet put away. */
    public var mayClose: Bool { !confirming && codes == nil }

    /*
     * Cancel, a swipe, or the sheet going away. False when refused: everything stays as it is. True
     * lets the setup go: a request another device approves afterwards confirms nothing.
     */
    @discardableResult
    public func close() -> Bool {
        guard mayClose else { return false }
        started = nil
        forget()
        return true
    }

    private func forget() {
        approved = nil
        awaitsCode = false
    }

    /* Done, under the codes. */
    public func done() { codes = nil }

    /* The password (and the step, once it is on) was given: the pending method. Nothing is sent with no device chosen. */
    public func begin(password: String, twoStep: StepAnswer?, start: Start = { try await TwoStep.startDevice(password: $0, twoStep: $1) }) async throws {
        guard chosen != nil else { throw Unchosen() }
        started = try await start(password, twoStep)
    }

    /* The request to the chosen device, for the first ask and for every Ask again. Nothing to ask with no device chosen, or no pending method. */
    public func request(wire: ApprovalWire, key: String) throws -> DeviceAsk.Request {
        guard let chosen else { throw Unchosen() }
        guard let started else { throw CancellationError() }
        return DeviceAsk.Request(wire: wire, token: started.token, purpose: DeviceEnrolment.purpose, key: key, approver: chosen.id)
    }

    /* The asking failed, or the confirmation did: back to the password. */
    public func failed() {
        guard !confirming else { return }
        started = nil
        forget()
    }

    /*
     * The chosen device approved `ask`'s request. Nothing is sent: an approval is that device's
     * word alone, and it turns nothing on. What follows is the code it now shows, typed here.
     * Only a request made for this setup's own token, to turn the method on, is taken.
     */
    public func approved(by ask: DeviceAsk) {
        guard let started, ask.token == started.token, ask.turnsOn, !confirming, codes == nil else { return }
        approved = ask
        awaitsCode = true
    }

    /*
     * The code the approving device shows was typed, and the button pressed: confirms the method
     * with the approved request and that code.
     *
     * - The code is checked here first, against the one this phone worked out itself. One try:
     *   anything else drops the request (`WrongCode`), and nothing is sent to the server.
     * - `confirming` is set before the request goes, and stays until its answer is kept.
     * - The request is not cancelled with whoever waits for it: once sent, its answer is taken.
     * - `step-pending` (the approval had not landed where this went) changed nothing: thrown, and the
     *   same setup is confirmed again.
     * - Turning the step on always comes back with the codes. Without them the reply is not the
     *   server's answer to that (`StepError.lost`): nothing is claimed.
     * - `removal` hears how the removal of the other devices ended (true: removed), after the codes.
     */
    public func confirm(
        typed: String, password: String,
        send: @escaping Confirm = { try await TwoStep.confirmDevice($0, requestId: $1, code: $2) },
        remove: @escaping Remove = { _ = try await Devices.removeOthers(password: $0, keep: $1) },
        removal: @escaping @MainActor @Sendable (Bool) -> Void = { _ in }
    ) async throws -> Confirmed {
        // Let go meanwhile (Cancel was pressed), or no device has approved: nothing is confirmed.
        guard let started, let chosen, let approved, !confirming, codes == nil else { throw CancellationError() }
        // Before anything else: nothing closes the sheet from here until the answer is kept.
        confirming = true
        guard let code = await approved.typed(typed) else {
            confirming = false
            forget()
            throw WrongCode()
        }
        let answer: TwoStep.DeviceConfirmed
        do {
            answer = try await Task { try await send(started, approved.requestId, code) }.value
        } catch {
            confirming = false
            // The approval had not landed where this went: the same request and code are confirmed again.
            if case StepError.refused(.pending, _) = error { throw error }
            // Anything else may hide a method that was turned on: this setup is over either way.
            self.started = nil
            forget()
            throw error
        }
        forget()
        switch answer {
        case .turnedOn(let made):
            // The codes first: they are shown once, and nothing that follows may cost them.
            codes = made
            confirming = false
            self.started = nil
            if first && removeOthers {
                removing = .running
                Task {
                    do {
                        try await remove(password, chosen.id)
                        self.removing = .no
                        removal(true)
                    } catch {
                        self.removing = .failed
                        removal(false)
                    }
                }
            }
            return .turnedOn
        case .added:
            confirming = false
            self.started = nil
            if first { throw StepError.lost(StepWords.lostTurnedOn) }
            return .added
        }
    }
}
