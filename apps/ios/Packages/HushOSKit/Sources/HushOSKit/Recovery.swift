import CryptoKit
import Foundation
import HushOSCore

/*
 * Forgot your password, in the app, as the web does it (apps/web routes/recover and
 * packages/auth client.recover): the server emails a link; the link's token is traded
 * for an enrollment cookie; the recovery kit (or its 24 words) opens the account key in
 * the core; a new password is registered with OPAQUE; the account key is sealed under it
 * with a fresh recovery phrase; and the core signs the reset with the old phrase's key, so
 * the server can check the person held it. Then a normal sign-in with the new password.
 */
public enum Recovery {
    public static let words = 24

    /* The phrase from a kit file the web or the apps saved: the line after "The same phrase on one line". */
    public static func phrase(fromKit text: String) -> [String]? {
        guard text.drop(while: \.isWhitespace).hasPrefix("HushOS recovery kit") else { return nil }
        let lines = text.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        guard let at = lines.firstIndex(where: { $0.hasPrefix("The same phrase on one line") }), at + 1 < lines.count else { return nil }
        let found = lines[at + 1].lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard found.count == words, found.allSatisfy({ word in !word.isEmpty && word.allSatisfy { $0 >= "a" && $0 <= "z" } }) else { return nil }
        return found
    }

    /*
     * The phrase from one look at a printed kit, or a QR code holding the phrase or the kit's
     * text. A camera misreads ("S1LK", "blina", "arřest"), splits a word across lines and reads
     * the kit's own numbered instructions, so each word read is corrected to the one BIP-39
     * word it can only be, and nothing is taken unless all 24 pass the phrase's checksum.
     */
    public static func phrase(fromScan text: String) -> [String]? {
        if let kit = phrase(fromKit: text) { return kit }
        if let run = phrase(inRun: text) { return run }
        let numbered = numberedWords(text)
        guard numbered.count == words else { return nil }
        let found = (1 ... words).compactMap { numbered[$0] }
        return entropy(found) == nil ? nil : found
    }

    /*
     * The kit's one-line phrase (or a QR code's) among what was read: 24 words in a row that
     * pass the checksum. A word the camera split at a line's end is joined back first.
     */
    static func phrase(inRun text: String) -> [String]? {
        let tokens = text.split(whereSeparator: { $0.isWhitespace || $0 == "," || $0 == "|" }).map(String.init)
        var read: [String?] = []
        var index = 0
        while index < tokens.count {
            if let word = scanned(tokens[index]) {
                read.append(word)
            } else if index + 1 < tokens.count, let joined = scanned(tokens[index] + tokens[index + 1]) {
                read.append(joined)
                index += 1
            } else {
                read.append(nil)
            }
            index += 1
        }
        guard read.count >= words else { return nil }
        for start in 0 ... (read.count - words) {
            let window = read[start ..< start + words].compactMap { $0 }
            if window.count == words, entropy(window) != nil { return window }
        }
        return nil
    }

    /*
     * The grid's numbered words: "12. leisure", or "12." on one line and the word on the next.
     * A number followed by more words ("1. Open HushOS and choose…") is the kit's
     * instructions, not the grid, and is skipped. Only "N." counts, as the kit prints it:
     * a camera reads "7." as "3:", and a word in the wrong place is worse than none.
     */
    public static func numberedWords(_ text: String) -> [Int: String] {
        var found: [Int: String] = [:]
        let pattern = /(?:^|[^\d\p{L}])(\d{1,2})\s*\.\s*([\p{L}][\p{L}\d]*)(?=[ \t]*(?:\d|\n|\r|$))/
        for match in text.matches(of: pattern.anchorsMatchLineEndings()) {
            guard let number = Int(match.1), (1 ... words).contains(number), found[number] == nil,
                  let word = scanned(String(match.2)) else { continue }
            found[number] = word
        }
        return found
    }

    /*
     * A word as a camera read it, made the BIP-39 word it can only be: digits that look like
     * letters, accents and case put right; then the list's own guarantee that no two words
     * share their first four letters; then a single slip of one letter, if only one word fits.
     */
    static func scanned(_ token: String) -> String? {
        let folded = token.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
        let lettered = String(folded.compactMap { character -> Character? in
            switch character {
            case "0": "o"
            case "1": "i"
            case "5": "s"
            case "a" ... "z": character
            default: nil
            }
        })
        guard lettered.count >= 3, lettered.count * 2 >= folded.count else { return nil }
        if BIP39.set.contains(lettered) { return lettered }
        // "1" reads as "l" as often as "i".
        if folded.contains("1"), case let other = lettered.replacingOccurrences(of: "i", with: "l"), BIP39.set.contains(other) { return other }
        if lettered.count >= 4, let word = BIP39.byPrefix[String(lettered.prefix(4))] { return word }
        let near = BIP39.words.filter { abs($0.count - lettered.count) <= 1 && oneEdit($0, lettered) }
        return near.count == 1 ? near[0] : nil
    }

    /* Whether two words differ by one letter changed, added or dropped. */
    private static func oneEdit(_ a: String, _ b: String) -> Bool {
        let a = Array(a), b = Array(b)
        if a.count == b.count { return zip(a, b).filter { $0 != $1 }.count == 1 }
        let (long, short) = a.count > b.count ? (a, b) : (b, a)
        guard long.count == short.count + 1 else { return false }
        var i = 0, j = 0, skipped = false
        while i < long.count, j < short.count {
            if long[i] == short[j] { i += 1; j += 1 } else if skipped { return false } else { skipped = true; i += 1 }
        }
        return true
    }

    /*
     * A live scan: each frame shows part of the grid clearly, so the numbered words are tallied
     * across frames and the most-read word wins each position. Done when one frame alone gives
     * the phrase, or the tally holds all 24 and they pass the checksum.
     */
    public struct ScanTally: Sendable {
        private var votes: [Int: [String: Int]] = [:]

        public init() {}

        public mutating func add(_ text: String) -> [String]? {
            if let whole = Recovery.phrase(fromScan: text) { return whole }
            for (number, word) in Recovery.numberedWords(text) { votes[number, default: [:]][word, default: 0] += 1 }
            guard votes.count == Recovery.words else { return nil }
            let best = (1 ... Recovery.words).compactMap { votes[$0]?.max { $0.value < $1.value }?.key }
            return Recovery.entropy(best) == nil ? nil : best
        }
    }

    /* Typed words, whatever the spacing or case. */
    public static func typedWords(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
    }

    /* BIP-39 words that start with what is typed, for completion; nothing for an empty start. */
    public static func completions(_ prefix: String, limit: Int = 4) -> [String] {
        let start = prefix.lowercased()
        guard !start.isEmpty else { return [] }
        return Array(BIP39.words.lazy.filter { $0.hasPrefix(start) }.prefix(limit))
    }

    /* The 32-byte secret the 24 words stand for; nil for an unknown word, a wrong count or a bad checksum. */
    static func entropy(_ phrase: [String]) -> Data? {
        guard phrase.count == words else { return nil }
        var bits: [UInt8] = []
        for word in phrase {
            guard let index = BIP39.index[word] else { return nil }
            for shift in (0 ..< 11).reversed() { bits.append(UInt8((index >> shift) & 1)) }
        }
        var bytes = Data()
        for start in stride(from: 0, to: 256, by: 8) { bytes.append(bits[start ..< start + 8].reduce(0) { $0 << 1 | $1 }) }
        let checksum = bits[256...].reduce(UInt8(0)) { $0 << 1 | $1 }
        return Data(SHA256.hash(data: bytes)).first == checksum ? bytes : nil
    }

    /* The core's message without its type around it, and the web's wording where it has its own. */
    static func message(_ error: Error) -> String {
        // The core's sentence or HushOS's own words, never a type's description.
        let text = (error as? CoreError).map(FamilyWords.message(of:)) ?? ErrorWords.say(error, otherwise: "Please try again.") ?? "Please try again."
        if text == "The recovery phrase does not match this account." { return "These words didn’t open your account. Check you used your newest kit." }
        return text
    }
}

extension BIP39 {
    static let set = Set(words)
    /* No two words share their first four letters (the list's own rule), so four letters name one. */
    static let byPrefix: [String: String] = Dictionary(uniqueKeysWithValues: words.filter { $0.count >= 4 }.map { (String($0.prefix(4)), $0) })
    static let index: [String: Int] = Dictionary(uniqueKeysWithValues: words.enumerated().map { ($1, $0) })
}

/* A verified recovery link: who it resets, and the enrollment the server will want back. */
public struct RecoveryEnrollment: Sendable, Equatable {
    public let email: String
    let origin: String
    let token: String
}

/* What a finished recovery leaves: the account signed in under the new password, and the phrase to save. */
public struct RecoveredAccount: Sendable {
    public let userId: String
    public let email: String
    /* Nil when the reset is done and the sign-in after it is not: the words are shown all the same, then sign-in. */
    public let user: SessionUser?
    public let phrase: String
    public let recoveryVersion: UInt64
    /* The new recovery key as JSON, for the kit file: with no session there is nothing to read it back with. */
    public let recovery: Data
    /*
     * False when the reset's reply was lost and nothing could say whether it happened: the words are
     * shown all the same (they may be the account's only way back), and the old ones are kept.
     */
    public let certain: Bool
}

/*
 * What a phrase reset comes to, decided away from the requests so every case is tested. Once the
 * server has taken the reset the old phrase is dead and the new one exists only in this phone's
 * memory: whatever the sign-in after it does, the new words are shown.
 */
public enum Reset {
    /* What `recover/finish` answered: the reset, a refusal in the server's words, or nothing of the server's own. */
    public enum Sent: Sendable, Equatable { case accepted, refused(String), unknown }

    /*
     * What signing in with the new password showed, by the versions in its reply (`Auth.proved`). That it
     * signed in shows nothing: a reset to the password the account already had signs in either way.
     */
    public enum Proved: Sendable, Equatable {
        /* The session's envelope is the reset's, or the step named the reset's recovery key and the new phrase passed it. */
        case signedIn(SessionUser)
        /* A reply showed the reset's version, but no session came of it. */
        case applied
        /* A reply showed the old version, or the new password was refused: the reset was not made. */
        case notApplied
        /* No reply showed a version. */
        case unknown

        fileprivate var rank: Int {
            switch self {
            case .signedIn: 3
            case .applied: 2
            case .notApplied: 1
            case .unknown: 0
            }
        }
    }

    public enum Settled: Sendable, Equatable {
        /* Show the new words; signed in or not; `certain` false when nothing says the reset was made. */
        case show(SessionUser?, certain: Bool)
        /* Nothing changed: the server's words, or that the account is still as it was. */
        case refused(String)
    }

    /* `notMade`: what is said when the account still shows its old versions (a reset's words, or a rotation's). */
    public static func settle(sent: Sent, proved: Proved, notMade: String = StepWords.notReset) -> Settled {
        switch (sent, proved) {
        case (.refused(let said), _): .refused(said)
        case (_, .signedIn(let user)): .show(user, certain: true)
        case (.accepted, _), (.unknown, .applied): .show(nil, certain: true)
        case (.unknown, .notApplied): .refused(notMade)
        case (.unknown, .unknown): .show(nil, certain: false)
        }
    }

    /*
     * Signs in after the reset, once more if the first try gave no session: a sign-in that failed
     * for a moment's reason is tried again while the words are still held. The better answer of the
     * two stands. An account that showed it was not reset is not asked again.
     */
    public static func prove(_ attempt: () async -> Proved) async -> Proved {
        let first = await attempt()
        switch first {
        case .signedIn, .notApplied: return first
        case .applied, .unknown:
            let second = await attempt()
            return second.rank >= first.rank ? second : first
        }
    }
}

extension Auth {
    static func recoveryRequest(_ origin: String, _ path: String, method: String = "POST", body: [String: Any]? = nil,
                                        enrollment: String? = nil) async throws -> (body: [String: Any], setCookie: String?) {
        guard let url = URL(string: origin + path) else { throw AuthError.message("Bad HushOS address.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        if let enrollment { request.setValue("\(enrollmentCookie(origin))=\(enrollment)", forHTTPHeaderField: "Cookie") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = 30
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        } catch {
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw AuthError.message("We couldn’t reach HushOS. Check your connection, then try again.")
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw AuthError.message(parsed["message"] as? String ?? "Something went wrong on HushOS. Try again in a moment.")
        }
        return (parsed, http.value(forHTTPHeaderField: "Set-Cookie"))
    }

    static func enrollmentCookie(_ origin: String) -> String { origin.hasPrefix("https:") ? "__Host-hushos-enrollment" : "hushos-enrollment" }

    /* The enrollment token in a Set-Cookie header, as sessionToken reads the session's. */
    static func enrollmentToken(setCookie header: String?) -> String? {
        guard let header else { return nil }
        var token: String?
        for cookie in header.components(separatedBy: ",") {
            guard let pair = cookie.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first else { continue }
            let trimmed = pair.trimmingCharacters(in: .whitespaces)
            guard let equals = trimmed.firstIndex(of: "=") else { continue }
            let name = trimmed[..<equals]
            guard name == "hushos-enrollment" || name == "__Host-hushos-enrollment" else { continue }
            let value = trimmed[trimmed.index(after: equals)...].trimmingCharacters(in: .whitespaces)
            token = value.isEmpty ? nil : value
        }
        return token
    }

    /* Step one: the server emails a link that opens the app (or the web) to reset. */
    public static func requestRecoveryEmail(origin: String, email: String) async throws {
        _ = try await recoveryRequest(origin, "/api/auth/recover/email", body: ["email": email])
    }

    /* The emailed link's token, traded for the enrollment; a link meant for sign-up says so. */
    public static func verifyRecoveryLink(origin: String, token: String) async throws -> RecoveryEnrollment {
        let reply = try await recoveryRequest(origin, "/api/auth/register/verify", body: ["token": token])
        let enrollment = reply.body["enrollment"] as? [String: Any]
        if let purpose = enrollment?["purpose"] as? String, purpose != "recover" {
            throw AuthError.message("This link belongs to a different account flow. Request a new link.")
        }
        guard let cookie = enrollmentToken(setCookie: reply.setCookie) else { throw AuthError.message("Unexpected reply from HushOS.") }
        let checked = try await recoveryRequest(origin, "/api/auth/recover", method: "GET", enrollment: cookie)
        guard let email = (checked.body["enrollment"] as? [String: Any])?["email"] as? String else {
            throw AuthError.message("This link belongs to a different account flow. Request a new link.")
        }
        return RecoveryEnrollment(email: email, origin: origin, token: cookie)
    }

    /*
     * The reset itself (packages/auth client.recover): opens the account key with the phrase,
     * registers the new password, seals the key under it one credential version up with a new
     * recovery phrase, signs all of it with the old phrase's key, then signs in.
     */
    public static func recover(_ enrollment: RecoveryEnrollment, password: String, phrase: [String]) async throws -> RecoveredAccount {
        let origin = enrollment.origin
        let registration = try opaqueStartRegistration(password: password)
        let challenge = try await recoveryRequest(origin, "/api/auth/recover/start", body: ["registrationRequest": registration.request],
                                                  enrollment: enrollment.token).body
        guard let userId = challenge["userId"] as? String, let attemptToken = challenge["attemptToken"] as? String,
              let registrationResponse = challenge["registrationResponse"] as? String,
              let credentialVersion = (challenge["credentialVersion"] as? NSNumber)?.uint64Value,
              let recoveryJson = challenge["recovery"] as? [String: Any]
        else { throw AuthError.message("Unexpected reply from HushOS.") }
        let old = recoveryEnvelope(from: recoveryJson)
        let accountKey: Data
        do {
            accountKey = try recoveryOpen(userId: userId, phrase: phrase.joined(separator: " "), envelope: old)
        } catch {
            throw AuthError.message(Recovery.message(error))
        }
        let registered = try opaqueFinishRegistration(password: password, state: registration.state, registrationResponse: registrationResponse)
        let sealed = try accountSeal(userId: userId, exportKey: registered.exportKey, accountKey: accountKey,
                                     keyVersion: old.keyVersion, credentialVersion: credentialVersion + 1)
        let fresh = try recoveryCreate(userId: userId, accountKey: accountKey, recoveryVersion: old.recoveryVersion + 1, keyVersion: old.keyVersion)
        // The core signs as the web does, with the old phrase's key, checked against the envelope the server sent.
        let signature: String
        do {
            signature = try recoveryResetSign(userId: userId, phrase: phrase.joined(separator: " "), current: old, attemptToken: attemptToken,
                                              credentialVersion: credentialVersion, registrationRecord: registered.record,
                                              envelope: sealed, recovery: fresh.envelope)
        } catch {
            throw AuthError.message(Recovery.message(error))
        }
        let sent = await resetSent(origin, body: [
            "userId": userId, "attemptToken": attemptToken, "credentialVersion": credentialVersion,
            "registrationRecord": registered.record,
            "envelope": [
                "envelopeVersion": sealed.envelopeVersion, "keyVersion": sealed.keyVersion, "credentialVersion": sealed.credentialVersion,
                "wrappingSalt": sealed.wrappingSalt, "wrappingNonce": sealed.wrappingNonce, "encryptedKey": sealed.encryptedKey,
            ],
            "recovery": json(fresh.envelope),
            "signature": signature,
        ], enrollment: enrollment.token)
        // Refused: nothing changed, and nothing is tried with the new password. Otherwise the old phrase may be dead
        // already and the new one is only here: the sign-in is tried (twice at most), and the words are shown whatever
        // it does. When the reset's own reply was lost, that sign-in is also what says whether it was made.
        var proved = Reset.Proved.unknown
        if case .refused = sent {} else {
            proved = await Reset.prove {
                await proveReset(origin: origin, email: enrollment.email, password: password, phrase: fresh.phrase,
                                 credentialVersion: sealed.credentialVersion, recoveryVersion: fresh.envelope.recoveryVersion)
            }
        }
        switch Reset.settle(sent: sent, proved: proved) {
        case .refused(let said):
            throw AuthError.message(said)
        case .show(let user, let certain):
            let recovery = (try? JSONSerialization.data(withJSONObject: json(fresh.envelope))) ?? Data()
            return RecoveredAccount(userId: userId, email: enrollment.email, user: user, phrase: fresh.phrase,
                                    recoveryVersion: fresh.envelope.recoveryVersion, recovery: recovery, certain: certain)
        }
    }

    /* Sends the reset and says what came back: the server's `{ user }`, its refusal, or nothing of its own. */
    static func resetSent(_ origin: String, body: [String: Any], enrollment: String) async -> Reset.Sent {
        guard let url = URL(string: origin + "/api/auth/recover/finish") else { return .refused("Bad HushOS address.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        request.setValue("\(enrollmentCookie(origin))=\(enrollment)", forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 30
        guard let (data, response) = try? await URLSession(configuration: testTransport ?? .ephemeral).data(for: request),
              let http = response as? HTTPURLResponse else { return .unknown }
        return resetSent(status: http.statusCode, body: (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    /*
     * The reset is the server's `{ user }` on a 2xx. A 4xx in its own words is a refusal, and nothing
     * changed. Anything else (a 5xx, a page from something in the way, a 2xx without the account)
     * says nothing either way.
     */
    static func resetSent(status: Int, body: [String: Any]) -> Reset.Sent {
        if (200 ..< 300).contains(status) { return body["user"] is [String: Any] ? .accepted : .unknown }
        if (400 ..< 500).contains(status), let said = body["message"] as? String, !said.isEmpty { return .refused(said) }
        return .unknown
    }

    /*
     * One sign-in with the new password, and what it shows about the reset. Signing in is not the evidence:
     * someone who reset to the password they already had signs in against the unchanged account. The
     * versions are: the session's envelope is sealed at the reset's credential version only if the reset
     * was made, and a second step names the reset's recovery key only then.
     *
     * - Made: the session is opened; or the step (docs/two-step-design.md 4, 5) is answered with the phrase
     *   just made here, which the person has not seen yet, so someone with only their phrase is not asked
     *   for a method they may have lost. A step that does not pass still shows the reset was made.
     * - Not made (an old version, or the new password refused): the probe's session is ended and never
     *   stored, and a step that names the old recovery key is not answered, so no wrong answer is counted.
     * - No reply shows a version: unknown.
     */
    static func proveReset(origin: String, email: String, password: String, phrase: String, credentialVersion: UInt64, recoveryVersion: UInt64) async -> Reset.Proved {
        await proved(
            probe: {
                switch try await passwordHalf(origin: origin, email: email, password: password) {
                case .step(let pending):
                    return .step(pending)
                case .session(let reply, let exportKey):
                    let sealedAt = ((reply.body["envelope"] as? [String: Any])?["credentialVersion"] as? NSNumber)?.uint64Value
                    return .session(credentialVersion: sealedAt,
                                    open: { try await openSession(origin: origin, email: email, exportKey: exportKey, reply: reply) },
                                    end: { if let token = reply.cookie { await endSession(origin: origin, token: token) } })
                }
            },
            answer: { pending, proof in try await answerStep(pending, proof: proof) },
            credentialVersion: credentialVersion, recoveryVersion: recoveryVersion, phrase: phrase
        )
    }

    /* What the sign-in with the new password met: a session not yet stored (with the version its envelope is sealed at), or the step. */
    enum ResetProbe {
        case session(credentialVersion: UInt64?, open: () async throws -> SessionUser, end: () async -> Void)
        case step(PendingSignIn)
    }

    /* The rule above, over a sign-in and a step's answer the caller supplies, so every way it can end is tested. */
    static func proved(probe: () async throws -> ResetProbe, answer: (PendingSignIn, StepProof) async throws -> SessionUser,
                       credentialVersion: UInt64, recoveryVersion: UInt64, phrase: String) async -> Reset.Proved {
        let met: ResetProbe
        do {
            met = try await probe()
        } catch AuthError.wrongPassword {
            return .notApplied
        } catch {
            // No answer, a limit, or the session's own reply gone missing: nothing shows a version.
            return .unknown
        }
        switch met {
        case .session(let sealedAt, let open, let end):
            if sealedAt == credentialVersion {
                guard let user = try? await open() else { return .applied }
                return .signedIn(user)
            }
            // The envelope the reset would have replaced: the password signs in because it was the password already.
            // Any other version says nothing of this reset. Either way the session was only asked for to look: ended, never stored.
            await end()
            return sealedAt == credentialVersion - 1 ? .notApplied : .unknown
        case .step(let pending):
            guard let signing = pending.challenge.phrase else { return .unknown }
            if signing.recoveryVersion == recoveryVersion {
                guard pending.challenge.methods.contains(.phrase),
                      let signature = try? twoStepPhraseSign(phrase: phrase, wrappingSalt: signing.wrappingSalt, userId: signing.userId, stepToken: pending.challenge.token),
                      let user = try? await answer(pending, .phrase(signature: signature))
                else { return .applied }
                return .signedIn(user)
            }
            // The old recovery key: the new phrase would be a wrong answer, and is not sent.
            return signing.recoveryVersion == recoveryVersion - 1 ? .notApplied : .unknown
        }
    }
}
