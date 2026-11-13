import Foundation
import HushOSCore

/*
 * Two-step sign-in on the phone (docs/two-step-design.md 4 to 7): the step a sign-in stops at, the
 * step a security change carries, and Account's settings for it. Codes are checked on the server;
 * the core reads every reply (`signInReplyRead`, `stepChangeReplyRead`) and signs the recovery
 * phrase's answer, so the phrase never leaves the phone.
 */

/* A sign-in stopped at its second step: the step, and what the password opened, kept in memory until the answer brings the envelope. */
public struct PendingSignIn: Sendable {
    public let origin: String
    public let email: String
    public let challenge: StepChallenge
    let exportKey: Data
    /* When the step arrived, on the clock that runs since boot (sleep included) and that nobody can set. */
    let received: ContinuousClock.Instant

    public init(origin: String, email: String, challenge: StepChallenge, exportKey: Data, received: ContinuousClock.Instant = .now) {
        self.origin = origin
        self.email = email
        self.challenge = challenge
        self.exportKey = exportKey
        self.received = received
    }

    /* The server's five minutes and one more, as the web allows. */
    public static let life: Duration = .seconds(360)

    /*
     * How long until this is dropped unanswered, with what the password opened (zero or less: now).
     * Nothing can answer it by then, and nothing of a password's work stays in memory behind a screen
     * left open.
     *
     * Counted from when the step arrived, never against its own `expiresAt`: that is the server's
     * wall clock, and a phone whose date is set a few minutes fast would find every step over before
     * it was shown, and could never sign in.
     */
    public func dropIn(now: ContinuousClock.Instant = .now) -> Duration {
        Self.life - received.duration(to: now)
    }
}

/*
 * Recovery words a phone showed and checked with no session to tell the server so (a rotation's, or
 * a reset's whose sign-in didn't happen): whose they are, on which server, and which phrase. The
 * check is recorded at the next sign-in only when all three are that sign-in's: another account
 * signing in on the phone, or the same one on another server, confirms nothing.
 */
public struct CheckedWords: Sendable, Equatable {
    public let userId: String
    public let origin: String
    public let recoveryVersion: UInt64

    public init(userId: String, origin: String, recoveryVersion: UInt64) {
        self.userId = userId
        self.origin = origin
        self.recoveryVersion = recoveryVersion
    }

    /* The version to confirm for a sign-in as `userId` on `origin`, or nil when the words were someone else's. */
    public func confirms(userId: String, origin: String) -> UInt64? {
        self.userId.lowercased() == userId.lowercased() && self.origin == origin && recoveryVersion > 0 ? recoveryVersion : nil
    }
}

/*
 * This phone's own rotation, from the request that ends its session to the sign-in that follows.
 * The session's end is its own doing all the way through, so "You've been signed out" says nothing
 * meanwhile: the mute is raised before the request goes out (a 401 can arrive from another request
 * before the rotation's own answer does), dropped if the rotation fails, and held while the new
 * words are on screen and while the sign-in after them is out. A sign-in by any road ends it.
 */
public struct OwnChange: Sendable, Equatable {
    public private(set) var underWay = false
    public private(set) var wordsHeld = false
    public private(set) var signingIn = false
    public private(set) var checked: CheckedWords?

    public init() {}

    /* Whether an ended session says nothing for now. */
    public var mutesSessionEnd: Bool { underWay || wordsHeld || signingIn }

    /* The rotation's request is about to go. */
    public mutating func begin() { underWay = true }
    /* It failed, or the app signed straight back in: nothing is held. */
    public mutating func ended() { underWay = false }
    /* It went through and the new words are on screen, with the sign-in still to come. */
    public mutating func hold() { underWay = false; wordsHeld = true }
    /* The words were saved and checked: the sign-in that waited goes out. */
    public mutating func wordsChecked(_ words: CheckedWords?) { wordsHeld = false; signingIn = true; checked = words }
    /* That sign-in answered, whatever it said. */
    public mutating func settled() { signingIn = false }
    /* Signed in, by this road or another: nothing is held, and the check is recorded if the words were this sign-in's. */
    public mutating func signedIn(userId: String, origin: String) -> UInt64? {
        let version = checked?.confirms(userId: userId, origin: origin)
        self = OwnChange()
        return version
    }
}

/* A step's token and the answer to it, as `login/two-step` and a change's `twoStep` field take them. */
public struct StepAnswer: Sendable, Equatable {
    public let token: String
    public let proof: StepProof

    public init(token: String, proof: StepProof) {
        self.token = token
        self.proof = proof
    }

    /* The method this answers with: what a refusal about "this method" is about. */
    public var method: StepMethod {
        switch proof {
        case .totp: .totp
        case .backup: .backup
        case .phrase: .phrase
        }
    }

    /* The core writes the JSON, so both phones send the same bytes. */
    func json() throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(stepAnswerJson(token: token, proof: proof).utf8)) as? [String: Any] else {
            throw AuthError.message(ErrorWords.generic)
        }
        return object
    }
}

/* What HushOS says itself about a step; everything else on these screens is the server's own sentence. */
public enum StepWords {
    /* The password's reply was not the server's answer: the person tries again from the password. */
    public static let lostSignIn = "The server’s answer didn’t arrive, so HushOS can’t tell whether you were signed in. Try again."
    /* The step's reply was not the server's answer: the same answer can be sent again, or the sign-in started over. */
    public static let lostStep = "The server’s answer didn’t arrive, so HushOS can’t tell whether you were signed in. Try again. If you used a code, you may need to wait for the next one."
    /* A change's reply was not the server's answer: it may have gone through. The web's sentence, naming what is unknown. */
    public static func lost(whether what: String) -> String { "The server’s answer didn’t arrive, so HushOS can’t tell whether \(what). Check before you try again." }
    public static let lostChange = lost(whether: "that went through")
    public static let lostSaved = lost(whether: "your change was saved")
    public static let lostDeleted = lost(whether: "your account was deleted")
    public static let lostSetup = lost(whether: "the setup was started")
    public static let lostAppAdded = lost(whether: "your authenticator app was added")
    /* Turning the step on always comes back with the codes: an answer without them is not the server's answer to that. */
    public static let lostTurnedOn = lost(whether: "two-step sign-in was turned on")
    public static let lostTurnedOff = lost(whether: "two-step sign-in was turned off")
    public static let lostNewCodes = lost(whether: "new backup codes were made")
    /* A sign-in with no step screen (the Files sheet). */
    public static let openApp = "This account asks for a second step. Open HushOS and sign in there."
    /* A step none of whose methods this build knows. */
    public static let cannotAnswer = "This version of HushOS can’t answer this account’s second step. Update HushOS, then try again."
    /* The ways ran out after refusals (a paused app, a spent budget): updating would not help. */
    public static let noWayLeft = "There is no other way to answer this step from here right now. Start again in a while."
    /* A rotation whose reply was lost, and the session then said it had not happened. */
    public static let notRotated = "Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again."
    /* A rotation whose reply was lost, and nothing could say whether it happened: the words are shown, and the old ones kept. */
    public static let rotationUncertain = "We couldn’t confirm that your recovery phrase was replaced. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you have signed in."
    /* A phrase reset whose reply was lost, and the account still shows its old versions: nothing changed, and the new words are not handed over. */
    public static let notReset = "Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again."
    /* A phrase reset whose reply was lost, and nothing could say whether it happened. */
    public static let resetUncertain = "We couldn’t confirm that your password was changed. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you have signed in."
    /*
     * The panel that shows new words to someone the change did not sign in again here, in the web's
     * words (apps/web/src/components/new-phrase.tsx): its title, what it says after each change, the
     * line under the words, and its way on.
     */
    public static let newPhraseTitle = "Save your new recovery phrase"
    public static let newPhraseAfterReset = "Your password is changed, and your old recovery phrase no longer works. These 24 words replace it."
    public static let newPhraseAfterRotation = "Your old recovery phrase no longer works. These 24 words replace it."
    public static let newPhraseOnce = "They are shown here once. If your account asks for a second step when you sign in, these words answer it."
    public static let newPhraseSaved = "I’ve saved these words"
    /* After a reset nothing confirmed: the password is not said to have changed. */
    public static let signInAfterUncertainReset = "Sign in with your new password. If it doesn’t work, your old one still does."
    /* After a reset whose sign-in didn't happen. */
    public static let signInAfterReset = "Your password was changed. Sign in with your new password."
    /* The removal of other devices, asked for while turning the step on, did not happen. */
    public static let othersNotRemoved = "Your other devices weren’t removed. You can remove them under Devices."
    /* A password exchange that waited a minute for its turn behind another: nothing was sent. The web's words for its own timeout. */
    public static let tookTooLong = "This took too long. Please try again."
    /* A step that ended with nothing said. */
    public static let over = "This sign-in timed out. Enter your password again."
}

/* A step that did not pass: the server's refusal in its own words, or a reply that was not the server's answer. */
public enum StepError: Error, LocalizedError, Sendable, Equatable {
    case refused(StepRefusal, String)
    case lost(String)

    public var errorDescription: String? {
        switch self {
        case .refused(_, let message), .lost(let message): return message
        }
    }

    /*
     * Whether a refused request is thrown as a `StepError`: when the server named one of the step's
     * codes. The address's own 429 (`busy`) and anything else it said stay the route's own error.
     */
    static func named(_ refusal: StepRefusal) -> Bool {
        switch refusal {
        case .wrong, .expired, .frozen, .limited, .unavailable, .required, .setupRequired, .updateRequired: true
        case .busy, .other: false
        }
    }
}

extension StepError: WordedError {}

/*
 * What the step screen does after an answer did not pass. Decided here, away from any view, so
 * every case is tested: a wrong answer asks again on the same step; a paused app, a spent budget
 * and a server that cannot check codes narrow what is offered; an ended step goes back to the
 * password with why; a lost reply offers the same answer again and never a stuck screen.
 */
public enum StepOutcome: Sendable, Equatable {
    /* Still answerable: the words, whether they are the field's own (a wrong answer), and what is offered now. */
    case again(message: String, field: Bool, methods: [StepMethod])
    /* Over: back to the password, with why. */
    case over(message: String)
    /* The reply was lost: say so, and offer to send the same answer again or start over. */
    case retry(message: String)

    /*
     * What is still offered after a refusal that takes something away (shared with `StepUp`):
     * - a paused app: everything but the app;
     * - a spent budget: the budget is one for the app's codes and the backup codes, so both go together;
     * - a method the server cannot check: only that one, the one that was `tried`. The app's secret and
     *   the backup codes can sit under different server keys, so one failing says nothing of the other.
     */
    public static func left(_ methods: [StepMethod], after refusal: StepRefusal, tried: StepMethod?) -> [StepMethod] {
        switch refusal {
        case .frozen: methods.filter { $0 != .totp }
        case .limited: methods.filter { $0 != .totp && $0 != .backup }
        case .unavailable: methods.filter { $0 != tried }
        default: methods
        }
    }

    /* Nil for a cancellation: nothing failed, and nothing is said. `tried` is the method the refused answer used. */
    public static func after(_ error: Error, methods: [StepMethod], tried: StepMethod? = nil) -> StepOutcome? {
        guard let words = ErrorWords.say(error) else { return nil }
        switch error {
        case StepError.lost(let message):
            return .retry(message: message)
        case StepError.refused(let refusal, let message):
            switch refusal {
            case .wrong:
                return .again(message: message, field: true, methods: methods)
            case .frozen, .limited, .unavailable:
                // Nothing changed; what the refusal was about is withdrawn, and the rest stays offered.
                return .again(message: message, field: false, methods: left(methods, after: refusal, tried: tried))
            case .busy:
                // The address's own limit: nothing about the step was looked at, and nothing is taken away.
                return .again(message: message, field: false, methods: methods)
            case .expired, .required, .setupRequired, .updateRequired, .other:
                return .over(message: message.isEmpty ? StepWords.over : message)
            }
        case is CoreError:
            // A mistyped phrase, refused on this phone before anything was sent.
            return .again(message: words, field: true, methods: methods)
        default:
            // Nothing came back at all, or something failed here: the same answer can be sent again.
            return .again(message: words, field: false, methods: methods)
        }
    }
}

/* What a person has typed for a step: one field for each method, so switching loses nothing. */
public struct StepDraft: Sendable, Equatable {
    public var method: StepMethod
    public var totp = ""
    public var backup = ""
    public var phrase = ""

    public init(methods: [StepMethod]) { method = methods.first ?? .totp }

    /* 0 to 9 only: `isNumber` also takes digits of other scripts, which no authenticator shows. */
    public static func digit(_ character: Character) -> Bool { character.isASCII && character.isNumber }

    public static func words(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /* The method shown: the chosen one while it is still offered, else the first that is; nil when none is. */
    public func shown(among methods: [StepMethod]) -> StepMethod? { methods.contains(method) ? method : methods.first }

    /* Why the draft cannot be sent yet, in the field's own words; nil when it can. */
    public func problem(for method: StepMethod) -> String? {
        switch method {
        case .totp:
            let digits = totp.filter { !$0.isWhitespace }
            return digits.count == 6 && digits.allSatisfy(StepDraft.digit) ? nil : "Enter the 6-digit code from your authenticator app."
        case .backup:
            return backupCodeNormalize(typed: backup) != nil ? nil : "Enter one of your backup codes, 10 characters."
        case .phrase:
            let count = Self.words(phrase).count
            return count == 24 ? nil : "Enter all 24 words of your recovery phrase. \(count) so far."
        }
    }

    /* The answer to `challenge`. The phrase is signed here (the core) and only its signature goes; a mistyped one throws the core's words. */
    public func answer(to challenge: StepChallenge, method: StepMethod) throws -> StepAnswer {
        switch method {
        case .totp:
            return StepAnswer(token: challenge.token, proof: .totp(code: totp))
        case .backup:
            return StepAnswer(token: challenge.token, proof: .backup(code: backup))
        case .phrase:
            guard let signing = challenge.phrase else { throw AuthError.message(StepWords.cannotAnswer) }
            let signature = try twoStepPhraseSign(
                phrase: Self.words(phrase).joined(separator: " "), wrappingSalt: signing.wrappingSalt, userId: signing.userId, stepToken: challenge.token
            )
            return StepAnswer(token: challenge.token, proof: .phrase(signature: signature))
        }
    }
}

/*
 * One password re-check at a time on this phone. Each one is an OPAQUE exchange bound to the session,
 * then the change it authorises (a new password, a rotation, deleting the account, removing devices, a
 * change to the step). Turning the step on leaves one running behind the backup codes (the removal of
 * the other devices) while the person is free to start another: taken in turn, the second starts only
 * once the first has finished, under the session the first left, and neither sees the other half done.
 */
actor PasswordTurn {
    static let shared = PasswordTurn()
    private var busy = false
    private var waiting: [(id: UUID, resume: CheckedContinuation<Bool, Never>)] = []

    /* How long a change waits for its turn before it gives up, with nothing sent. */
    static let wait: Duration = .seconds(60)

    /* True with the turn taken. False when `within` ran out first: the caller has no turn, and its place in the line is gone. */
    @discardableResult
    func enter(within limit: Duration? = nil) async -> Bool {
        if !busy { busy = true; return true }
        let id = UUID()
        if let limit {
            Task { try? await Task.sleep(for: limit); self.expire(id) }
        }
        return await withCheckedContinuation { waiting.append((id, $0)) }
    }

    private func expire(_ id: UUID) {
        guard let at = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: at).resume.resume(returning: false)
    }

    /* Hands the turn to whoever has waited longest, or frees it. */
    func leave() {
        if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume.resume(returning: true) }
    }

    /* For a `defer`, which cannot wait. */
    nonisolated func leaveSoon() { Task { await leave() } }

    /*
     * Takes the shared turn for a password exchange. Whoever was cancelled while waiting gives the
     * turn straight back and throws: a change nobody is waiting for any more is not made late.
     * Pair with `defer { PasswordTurn.shared.leaveSoon() }`.
     */
    static func take(_ turn: PasswordTurn = .shared, within limit: Duration = PasswordTurn.wait) async throws {
        // The one ahead is taking a minute (a server that answers slowly, more than once): said, not sat through.
        guard await turn.enter(within: limit) else { throw AuthError.message(StepWords.tookTooLong) }
        if Task.isCancelled {
            await turn.leave()
            throw CancellationError()
        }
    }
}

/* What a change asks the step for: the server binds the token to the session and this purpose. */
public enum StepPurpose: String, Sendable {
    case password, masterKey = "master-key", recoveryKey = "recovery-key", delete, twoStep = "two-step"
}

/* GET /api/auth/two-step: whether the step is on, its methods, the codes left, and whether the app is paused for new devices. */
public struct TwoStepStatus: Sendable, Equatable {
    public struct Method: Sendable, Equatable, Identifiable {
        public let id: String
        /* "totp", or "webauthn" once security keys exist. */
        public let kind: String
        public let name: String?
        public let createdAt: Date?
        public let lastUsedAt: Date?
    }

    public let on: Bool
    public let methods: [Method]
    public let backupCodesLeft: Int
    public let totpFrozen: Bool

    /* The authenticator app, if one is confirmed: an account has at most one. */
    public var app: Method? { methods.first { $0.kind == "totp" } }

    init?(_ json: [String: Any]) {
        guard let on = json["on"] as? Bool, let rows = json["methods"] as? [[String: Any]] else { return nil }
        self.on = on
        methods = rows.compactMap { row in
            guard let id = row["id"] as? String, let kind = row["kind"] as? String else { return nil }
            return Method(id: id, kind: kind, name: row["name"] as? String, createdAt: TwoStep.date(row["createdAt"]), lastUsedAt: TwoStep.date(row["lastUsedAt"]))
        }
        backupCodesLeft = (json["backupCodesLeft"] as? NSNumber)?.intValue ?? 0
        totpFrozen = json["totpFrozen"] as? Bool ?? false
    }

    /* "7 of 10 left", with what to do when they run low, as the web says it. */
    public var codesLeft: String {
        if backupCodesLeft == 0 { return "None left. Make a new set." }
        return backupCodesLeft <= 2 ? "\(backupCodesLeft) of 10 left. Make a new set soon." : "\(backupCodesLeft) of 10 left"
    }
}

/* POST /api/auth/two-step/totp: the pending app's key, shown once, and its `otpauth://` address. */
public struct TotpEnrolment: Sendable, Equatable {
    public let id: String
    public let secret: String
    public let uri: String

    /* The key in groups of four, as authenticator apps show it for typing. */
    public var grouped: String {
        stride(from: 0, to: secret.count, by: 4).map { start -> String in
            let from = secret.index(secret.startIndex, offsetBy: start)
            return String(secret[from ..< (secret.index(from, offsetBy: 4, limitedBy: secret.endIndex) ?? secret.endIndex)])
        }
        .joined(separator: " ")
    }

    /* The address an authenticator app opens, only when it is one: nothing else the server sent is ever opened. */
    public var link: URL? { uri.hasPrefix("otpauth://totp/") ? URL(string: uri) : nil }

    /*
     * The line under "Remove my other devices". The count is only for the words: unknown (the list
     * didn't load) or zero, the line says what ticking does without one, and the box is there all the same.
     */
    public static func othersLine(_ others: Int?) -> String {
        guard let others, others > 0 else { return "Any other device signed in to your account will need to sign in again, and will be asked for the second step." }
        return "\(others == 1 ? "One other device is" : "\(others) other devices are") signed in without the second step. They’ll need to sign in again, and will be asked for it."
    }
}

/* One line of Recent security activity (docs/two-step-design.md 7): a kind of event, of method and of device; never a name or an address. */
public struct SecurityEvent: Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let method: String?
    public let deviceKind: String?
    public let createdAt: Date?

    init?(_ json: [String: Any]) {
        guard let id = json["id"] as? String, let kind = json["kind"] as? String else { return nil }
        self.id = id
        self.kind = kind
        method = json["method"] as? String
        deviceKind = json["deviceKind"] as? String
        createdAt = TwoStep.date(json["createdAt"])
    }

    public init(id: String, kind: String, method: String?, deviceKind: String?, createdAt: Date?) {
        self.id = id
        self.kind = kind
        self.method = method
        self.deviceKind = deviceKind
        self.createdAt = createdAt
    }

    /* What happened, in the web's words; a kind this build does not know is still listed. */
    public var words: String {
        let with: String? = switch method {
        case "totp": "an authenticator code"
        case "backup": "a backup code"
        case "phrase": "your recovery phrase"
        case "webauthn": "a security key"
        default: nil
        }
        switch kind {
        case "sign-in": return with.map { "Signed in with your password and \($0)" } ?? "Signed in"
        case "step-failed": return with.map { "Wrong answer to the second step, with \($0)" } ?? "Wrong answer to the second step"
        case "totp-frozen": return "Authenticator app paused after many wrong answers"
        case "backup-code-used": return "Backup code used"
        case "phrase-used": return "Recovery phrase used for the second step"
        case "two-step-on": return "Two-step sign-in turned on"
        case "two-step-off": return "Two-step sign-in turned off"
        // Said by the kind of method, so the line is right for a security key too.
        case "method-added": return method == "webauthn" ? "Security key added" : method == "totp" ? "Authenticator app replaced" : "Second-step method added"
        case "method-removed": return method == "webauthn" ? "Security key removed" : method == "totp" ? "Authenticator app removed" : "Second-step method removed"
        case "backup-codes-made": return "New backup codes made"
        default: return "Security change"
        }
    }

    /* "Browser", "iPhone or iPad", "Android"; nil when the server names no kind. */
    public var device: String? {
        switch deviceKind {
        case "web": "Browser"
        case "ios": "iPhone or iPad"
        case "android": "Android"
        default: nil
        }
    }
}

public enum TwoStep {
    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        return (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true).timeZone(separator: .omitted)))
            ?? (try? Date(text, strategy: .iso8601))
    }

    /* The account's two-step settings; nil on a server that has two-step off (501), where Account shows nothing of it. */
    public static func status() async throws -> TwoStepStatus? {
        let reply = try await Auth.request("/api/auth/two-step")
        if reply.status == 501 { return nil }
        if reply.status == 401 { throw AuthError.sessionEnded(session: reply.session.tag) }
        guard reply.status == 200, let status = TwoStepStatus(reply.body) else {
            throw AuthError.message(reply.status == 200 ? "Two-step sign-in couldn’t be loaded." : reply.body["message"] as? String ?? "Two-step sign-in couldn’t be loaded.")
        }
        return status
    }

    /* The last 90 days, newest first. */
    public static func securityEvents() async throws -> [SecurityEvent] {
        let reply = try await Auth.call("/api/auth/security-events")
        return (reply["events"] as? [[String: Any]] ?? []).compactMap(SecurityEvent.init)
    }

    /*
     * A step for a change this session makes. Nil when the account has no step (409): the change
     * goes without one. The route does not look at TWO_STEP_ENABLED (only setting the step up and
     * managing it answer 501 while that is off): an account that has the step is asked for it on
     * every server.
     */
    public static func challenge(_ purpose: StepPurpose) async throws -> StepChallenge? {
        let reply = try await Auth.request("/api/auth/two-step/challenge", method: "POST", body: ["purpose": purpose.rawValue])
        if reply.status == 401 { throw AuthError.sessionEnded(session: reply.session.tag) }
        if reply.status == 409 { return nil }
        switch stepChallengeReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .step(let challenge): return challenge
        case .refused(let refusal, let message): throw StepError.refused(refusal, message)
        case .done, .lost: throw StepError.lost(StepWords.lostChange)
        }
    }

    /* Changing the step proves the password again: an OPAQUE exchange bound to this session (`two-step/reauth`). */
    private static func passwordProof(_ password: String) async throws -> [String: Any] {
        let login = try opaqueStartLogin(password: password)
        let started = try await Auth.call("/api/auth/two-step/reauth", method: "POST", body: ["startLoginRequest": login.request])
        guard let attemptToken = started["attemptToken"] as? String, let loginResponse = started["loginResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        guard let finish = try opaqueFinishLogin(password: password, state: login.state, loginResponse: loginResponse) else {
            throw AuthError.message("That password isn’t right. Check it and try again.")
        }
        return ["attemptToken": attemptToken, "finishLoginRequest": finish.request]
    }

    private static func change(_ password: String, _ twoStep: StepAnswer?) async throws -> [String: Any] {
        var body = try await passwordProof(password)
        if let twoStep { body["twoStep"] = try twoStep.json() }
        return body
    }

    /* A pending authenticator app, good for ten minutes: the key to type and the address to open. `twoStep` once the step is on (replacing the app). */
    public static func startAuthenticator(password: String, twoStep: StepAnswer? = nil) async throws -> TotpEnrolment {
        try await PasswordTurn.take()
        defer { PasswordTurn.shared.leaveSoon() }
        let reply = try await Auth.call("/api/auth/two-step/totp", method: "POST", body: try await change(password, twoStep), whole: true, lost: StepWords.lostSetup)
        guard let app = enrolment(reply) else { throw StepError.lost(StepWords.lostSetup) }
        return app
    }

    /*
     * The readers below take a 200's body and give the server's own answer, or nil: the web's
     * `readEnrolment`, `readRemoved` and `readBackupCodes` (packages/auth/src/login-reply.ts). A body
     * that is merely an object (a proxy's `{ "error": … }`) is none of them, and its change is not
     * reported as made.
     */

    /* A pending app: its id, its key and its address, each there. */
    static func enrolment(_ body: [String: Any]) -> TotpEnrolment? {
        guard let id = body["id"] as? String, let secret = body["secret"] as? String, let uri = body["uri"] as? String, !id.isEmpty, !secret.isEmpty, !uri.isEmpty else { return nil }
        return TotpEnrolment(id: id, secret: secret, uri: uri)
    }

    /* A removed method: `removed` true, and whether the step is still on. */
    static func removed(_ body: [String: Any]) -> Bool? {
        guard (body["removed"] as AnyObject) === kCFBooleanTrue, let on = body["on"], (on as AnyObject) === kCFBooleanTrue || (on as AnyObject) === kCFBooleanFalse else { return nil }
        return (on as AnyObject) === kCFBooleanTrue
    }

    /* A new set of codes: a list that is not empty, of text that is not empty. */
    static func codes(_ body: [String: Any]) -> [String]? {
        guard let codes = body["codes"] as? [String], !codes.isEmpty, codes.allSatisfy({ !$0.isEmpty }) else { return nil }
        return codes
    }

    /* Thrown when the pending app ran out (ten minutes): the setup starts again. */
    public struct SetupTimedOut: Error, WordedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }
    }

    /* What confirming the pending app did: it turned the step on (the ten backup codes, shown once), or it replaced the app. */
    public enum Confirmed: Sendable, Equatable {
        case turnedOn([String])
        case replaced
    }

    /*
     * The server's answer to a confirmation, exactly: `{ "backupCodes": [...] }` when it turned the
     * step on, `{ "replaced": true }` when it replaced the app. Anything else is not one: an empty
     * object, an object with other keys (a proxy's `{ "error": … }` with a 200), codes that are not
     * text. Read as "replaced", such a reply would tell someone their new app is on when nothing says so.
     */
    static func confirmed(_ body: [String: Any]) -> Confirmed? {
        guard body.count == 1, let (key, value) = body.first.map({ ($0.key, $0.value) }) else { return nil }
        switch key {
        case "backupCodes":
            guard let codes = value as? [String], !codes.isEmpty, codes.allSatisfy({ !$0.isEmpty }) else { return nil }
            return .turnedOn(codes)
        case "replaced":
            // The JSON `true` itself, not a 1 that bridges to it.
            return (value as AnyObject) === kCFBooleanTrue ? .replaced : nil
        default:
            return nil
        }
    }

    /* Confirms the pending app with a code from it. A reply that is neither of the server's two answers is lost: the app may have been added. */
    public static func confirmAuthenticator(id: String, code: String) async throws -> Confirmed {
        let reply = try await Auth.request("/api/auth/two-step/totp/\(id)/confirm", method: "POST", body: ["code": code.filter { !$0.isWhitespace }])
        switch stepChangeReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .done:
            guard let confirmed = confirmed(reply.body) else { throw StepError.lost(StepWords.lostAppAdded) }
            return confirmed
        case .refused(let refusal, let message):
            if reply.status == 401 { throw AuthError.sessionEnded(session: reply.session.tag) }
            if reply.status == 404 { throw SetupTimedOut(message: message) }
            throw StepError.refused(refusal, message)
        case .step, .lost:
            throw StepError.lost(StepWords.lostAppAdded)
        }
    }

    /* Removes a method: the password and the step. Returns whether the step is still on; removing the last turns it off and deletes the codes. */
    @discardableResult
    public static func removeMethod(_ id: String, password: String, twoStep: StepAnswer?) async throws -> Bool {
        try await PasswordTurn.take()
        defer { PasswordTurn.shared.leaveSoon() }
        let reply = try await Auth.call("/api/auth/two-step/methods/\(id)", method: "DELETE", body: try await change(password, twoStep), whole: true, lost: StepWords.lostTurnedOff)
        guard let on = removed(reply) else { throw StepError.lost(StepWords.lostTurnedOff) }
        return on
    }

    /* A new set of ten backup codes, which replaces the old one, shown once. */
    public static func newBackupCodes(password: String, twoStep: StepAnswer?) async throws -> [String] {
        try await PasswordTurn.take()
        defer { PasswordTurn.shared.leaveSoon() }
        let reply = try await Auth.call("/api/auth/two-step/backup-codes", method: "POST", body: try await change(password, twoStep), whole: true, lost: StepWords.lostNewCodes)
        guard let made = codes(reply) else { throw StepError.lost(StepWords.lostNewCodes) }
        return made
    }

    /* The codes as a note to keep: what the web's download writes. */
    public static func codesNote(_ codes: [String], email: String, made: Date = Date()) -> String {
        let day = made.formatted(Date.FormatStyle(date: .long, time: .omitted).locale(Locale(identifier: "en_GB")))
        return (["HushOS backup codes", "Account: \(email)", "Made: \(day)", "", "Each code works once, in place of a code from your authenticator app.", ""] + codes + [""])
            .joined(separator: "\n")
    }
}

/*
 * The second step before a change this session makes (a new password, a rotation, deleting the
 * account, a change to the step itself), as the web's `useStepUp`: whether one must be answered,
 * what was typed, and what a refusal means for the form. The views hold one and show its fields.
 */
public struct StepUp: Sendable, Equatable {
    public let purpose: StepPurpose
    public private(set) var challenge: StepChallenge?
    public private(set) var methods: [StepMethod] = []
    public var draft = StepDraft(methods: [])
    /* What the server said about the last answer. */
    public private(set) var error = ""
    /* Set once the person has tried to send it: the field's own complaint shows from then. */
    public private(set) var tried = false

    public init(purpose: StepPurpose) { self.purpose = purpose }

    /* Whether the form shows the step's fields. */
    public var asked: Bool { challenge != nil }
    public var shown: StepMethod? { draft.shown(among: methods) }
    /* What to show under the field: the field's own complaint once tried, else the server's words. */
    public var problem: String {
        if tried, let method = shown, let problem = draft.problem(for: method) { return problem }
        return error
    }

    public mutating func typed() { error = "" }

    public mutating func take(_ next: StepChallenge?, keep: Bool = false) {
        challenge = next
        methods = next?.methods ?? []
        tried = false
        if !keep || next == nil { draft = StepDraft(methods: methods) }
    }

    /*
     * What the change carries: nil when no step is asked, and thrown `Unready` when what was typed
     * cannot be sent yet (the field says why).
     */
    public struct Unready: Error {}
    public mutating func prove() throws -> StepAnswer? {
        guard let challenge else { return nil }
        tried = true
        // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
        guard let method = shown else { throw AuthError.message(challenge.methods.isEmpty ? StepWords.cannotAnswer : StepWords.noWayLeft) }
        if draft.problem(for: method) != nil { throw Unready() }
        do {
            return try draft.answer(to: challenge, method: method)
        } catch let error as CoreError {
            // A mistyped phrase: the core's words, beside the field.
            self.error = ErrorWords.say(error) ?? ""
            tried = false
            throw Unready()
        }
    }

    /* What a failed change means for the step. */
    public enum Next: Sendable, Equatable {
        /* Not the step's: the form shows the error as its own. */
        case notStep
        /* The step's, and its fields say why: the same step can be answered again. */
        case again
        /* A new step is needed (none was asked yet, or this one is over): fetch one, keeping what was typed. */
        case renew
    }

    public mutating func failed(_ failure: Error) -> Next {
        guard case StepError.refused(let refusal, let message) = failure else { return .notStep }
        switch refusal {
        case .required:
            // Asked for the first time: the fields appear, and say nothing yet.
            error = challenge == nil ? "" : message
            return .renew
        case .expired:
            error = message
            return .renew
        case .wrong:
            error = message
            tried = false
            return .again
        case .frozen, .limited, .unavailable:
            error = message
            tried = false
            // The method on screen is the one the refused change carried.
            methods = StepOutcome.left(methods, after: refusal, tried: shown)
            return .again
        case .setupRequired, .updateRequired, .busy, .other:
            return .notStep
        }
    }
}
