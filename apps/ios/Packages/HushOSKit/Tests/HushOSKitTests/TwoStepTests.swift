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

    @Test func aSpentBudgetWithdrawsTheCodeMethodsTogether() {
        // One 15-minute budget covers the app's codes and the backup codes: offering the other one would only be refused too.
        let limited = "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase."
        for tried in [StepMethod.totp, .backup] {
            #expect(StepOutcome.after(StepError.refused(.limited, limited), methods: all, tried: tried) == .again(message: limited, field: false, methods: [.phrase]))
        }
        // With no phrase to fall back on nothing is left, and the screen says so rather than show a field every answer to which is refused.
        #expect(StepOutcome.after(StepError.refused(.limited, limited), methods: [.totp, .backup], tried: .totp) == .again(message: limited, field: false, methods: []))
    }

    @Test func aMethodTheServerCannotCheckIsWithdrawnAloneAndTheOthersStayOffered() {
        // `step-unavailable` is per method: the app's secret and the backup codes can sit under different server keys.
        // Withdrawing both for one would send someone to their recovery phrase while a backup code still works.
        let said = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
        #expect(StepOutcome.after(StepError.refused(.unavailable, said), methods: all, tried: .totp) == .again(message: said, field: false, methods: [.backup, .phrase]))
        #expect(StepOutcome.after(StepError.refused(.unavailable, said), methods: all, tried: .backup) == .again(message: said, field: false, methods: [.totp, .phrase]))
        #expect(StepOutcome.after(StepError.refused(.unavailable, said), methods: [.totp, .backup], tried: .backup) == .again(message: said, field: false, methods: [.totp]))
        // Unlike a spent budget, which is one for both kinds of code.
        #expect(StepOutcome.left(all, after: .limited, tried: .backup) == [.phrase])
        // The same inside a form: the method on screen is the one that was sent.
        var step = StepUp(purpose: .password)
        step.take(challenge())
        step.draft.method = .backup
        #expect(step.failed(StepError.refused(.unavailable, said)) == .again)
        #expect(step.methods == [.totp, .phrase])
        #expect(step.shown == .totp)
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
        // Nothing of the phrase is in what is sent: the token, the kind, and a 64-byte signature, with no other field
        // to carry a word. (Not a search for the words: "nature" is in "signature", and a random phrase has it now and then.)
        let sent = try answer.json()
        let proof = sent["proof"] as? [String: Any] ?? [:]
        #expect(Set(sent.keys) == ["token", "proof"])
        #expect(Set(proof.keys) == ["kind", "signature"])
        #expect(sent["token"] as? String == token)
        #expect(proof["kind"] as? String == "phrase")
        #expect(try base64urlDecode(value: proof["signature"] as? String ?? "").count == 64)
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

    @Test func whenTheWaysRanOutAfterRefusalsTheFormDoesNotSayToUpdate() {
        // A spent budget on an account whose step offers no phrase here: updating HushOS would change nothing.
        var step = StepUp(purpose: .password)
        step.take(challenge([.totp, .backup]))
        _ = step.failed(StepError.refused(.limited, "Too many wrong codes."))
        #expect(step.methods.isEmpty)
        #expect(throws: AuthError.message(StepWords.noWayLeft)) { try step.prove() }
        // Nothing this build knows was offered at all: that is the one an update fixes.
        step.take(challenge([]))
        #expect(throws: AuthError.message(StepWords.cannotAnswer)) { try step.prove() }
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

/* What survives a failure after the server has already made a change. */
@Suite struct KeptWordsTests {
    let user = SessionUser(id: "u", name: "Maya", email: "maya@example.org", credentialVersion: 3, role: "member")

    @Test func onceTheResetIsTakenTheNewWordsAreShownWhateverTheSignInDoes() {
        // The old phrase is dead the moment recover/finish succeeds, and the new one is only in memory. Dropped
        // because the sign-in after it failed (no network, a 429, a step that didn't pass), the account has no phrase
        // anyone has seen.
        for proved in [Reset.Proved.applied, .unknown, .notApplied] {
            #expect(Reset.settle(sent: .accepted, proved: proved) == .show(nil, certain: true), "\(proved)")
        }
        #expect(Reset.settle(sent: .accepted, proved: .signedIn(user)) == .show(user, certain: true))
    }

    @Test func aResetWhoseOwnReplyWasLostIsSettledByTheSignInWithTheNewPassword() {
        // The new password signs in, or gets as far as the step: the reset was made, and the words are the account's.
        #expect(Reset.settle(sent: .unknown, proved: .signedIn(user)) == .show(user, certain: true))
        #expect(Reset.settle(sent: .unknown, proved: .applied) == .show(nil, certain: true))
        // It is not the account's password: nothing changed, and the new words are not shown as anyone's.
        #expect(Reset.settle(sent: .unknown, proved: .notApplied) == .refused(StepWords.notReset))
        // Nothing answers: the words are kept and shown, and said to be uncertain so the old ones are kept too.
        #expect(Reset.settle(sent: .unknown, proved: .unknown) == .show(nil, certain: false))
        // A refusal in the server's words changed nothing, whatever else is known.
        #expect(Reset.settle(sent: .refused("This link has expired."), proved: .unknown) == .refused("This link has expired."))
    }

    @Test func whatRecoverFinishAnsweredIsReadFromItsOwnShape() {
        #expect(Auth.resetSent(status: 200, body: ["user": ["id": "u"]]) == .accepted)
        // A 200 that is not the account (a proxy's page parsed as nothing), and any 5xx: nothing says either way.
        #expect(Auth.resetSent(status: 200, body: [:]) == .unknown)
        #expect(Auth.resetSent(status: 503, body: ["message": "Authentication is temporarily unavailable. Please try again."]) == .unknown)
        #expect(Auth.resetSent(status: 502, body: [:]) == .unknown)
        // A 4xx in the server's words is a refusal: the old phrase still works, and the new words are never shown.
        #expect(Auth.resetSent(status: 401, body: ["message": "That recovery phrase isn’t right."]) == .refused("That recovery phrase isn’t right."))
        #expect(Auth.resetSent(status: 429, body: [:]) == .unknown)
    }

    actor Attempts {
        var answers: [Reset.Proved]
        var made = 0
        init(_ answers: [Reset.Proved]) { self.answers = answers }
        func next() -> Reset.Proved { made += 1; return answers.isEmpty ? .unknown : answers.removeFirst() }
    }

    @Test func theSignInAfterAResetIsTriedOnceMoreAndItsStepFailingStillProvesThePassword() async {
        // The step path failing (a lost reply to login/two-step) leaves "applied": tried again, and signed in the second time.
        var attempts = Attempts([.applied, .signedIn(user)])
        #expect(await Reset.prove { await attempts.next() } == .signedIn(user))
        #expect(await attempts.made == 2)
        // Still no session the second time: the password stays proved, so the words are shown and sign-in follows.
        attempts = Attempts([.applied, .unknown])
        #expect(await Reset.prove { await attempts.next() } == .applied)
        #expect(Reset.settle(sent: .accepted, proved: .applied) == .show(nil, certain: true))
        // Signed in, or a password that is not the account's: not tried again.
        attempts = Attempts([.signedIn(user), .unknown])
        _ = await Reset.prove { await attempts.next() }
        #expect(await attempts.made == 1)
        attempts = Attempts([.notApplied, .signedIn(user)])
        #expect(await Reset.prove { await attempts.next() } == .notApplied)
        #expect(await attempts.made == 1)
    }

    /* A probe that met a session sealed at `version`, and whether it was then opened or ended. */
    actor Looked {
        var opened = 0
        var ended = 0
        func open() { opened += 1 }
        func end() { ended += 1 }
    }

    func session(_ version: UInt64?, _ looked: Looked, fails: Bool = false) -> Auth.ResetProbe {
        let user = user
        return .session(credentialVersion: version,
                        open: { await looked.open(); if fails { throw AuthError.noSession }; return user },
                        end: { await looked.end() })
    }

    @Test func aResetToTheSamePasswordWithItsReplyLostIsNotSaidToBeAppliedBecauseItSignsIn() async {
        // The reset writes credential version 4 over 3. Someone who "reset" to the password they already had signs in
        // fine against the unchanged account: read as applied, they would be handed words the server never took, and
        // throw away a kit that is still the only one that works.
        let unchanged = Looked()
        let proved = await Auth.proved(probe: { self.session(3, unchanged) }, answer: { _, _ in self.user }, credentialVersion: 4, recoveryVersion: 2, phrase: "")
        #expect(proved == .notApplied)
        #expect(Reset.settle(sent: .unknown, proved: proved) == .refused(StepWords.notReset))
        // The session was only asked for to look: never stored on the phone, and ended on the server.
        #expect(await unchanged.opened == 0)
        #expect(await unchanged.ended == 1)
        // The reset's own envelope: made, and this is the sign-in.
        let reset = Looked()
        #expect(await Auth.proved(probe: { self.session(4, reset) }, answer: { _, _ in self.user }, credentialVersion: 4, recoveryVersion: 2, phrase: "") == .signedIn(user))
        #expect(await reset.opened == 1)
        #expect(await reset.ended == 0)
        // Made, but the session could not be stored: still made, and the words are shown.
        #expect(await Auth.proved(probe: { self.session(4, Looked(), fails: true) }, answer: { _, _ in self.user }, credentialVersion: 4, recoveryVersion: 2, phrase: "") == .applied)
        // A version that is neither, or none in the reply: nothing is known, and the session is not kept.
        for version in [nil, 7] as [UInt64?] {
            let odd = Looked()
            #expect(await Auth.proved(probe: { self.session(version, odd) }, answer: { _, _ in self.user }, credentialVersion: 4, recoveryVersion: 2, phrase: "") == .unknown)
            #expect(await odd.opened == 0)
            #expect(await odd.ended == 1)
        }
        // When the server's own reply confirmed the reset, that stands whatever the look afterwards showed.
        #expect(Reset.settle(sent: .accepted, proved: .notApplied) == .show(nil, certain: true))
    }

    actor Sent {
        var proofs: [StepProof] = []
        func took(_ proof: StepProof) { proofs.append(proof) }
    }

    @Test func theStepAfterAResetIsAnsweredOnlyWhenItNamesTheNewRecoveryKey() async throws {
        let userId = UUID().uuidString.lowercased()
        let fresh = try recoveryCreate(userId: userId, accountKey: randomBytes(length: 32), recoveryVersion: 2, keyVersion: 1)
        func pending(_ recoveryVersion: UInt64?, _ methods: [StepMethod] = [.totp, .phrase]) -> PendingSignIn {
            var step = challenge(methods)
            step.phrase = recoveryVersion.map { StepPhrase(userId: userId, recoveryVersion: $0, wrappingSalt: fresh.envelope.wrappingSalt) }
            return PendingSignIn(origin: "https://step.test", email: "maya@example.org", challenge: step, exportKey: Data(repeating: 1, count: 64))
        }
        let user = user
        func prove(_ step: PendingSignIn, _ sent: Sent, fails: Bool = false) async -> Reset.Proved {
            await Auth.proved(probe: { .step(step) }, answer: { _, proof in await sent.took(proof); if fails { throw StepError.lost(StepWords.lostStep) }; return user },
                              credentialVersion: 4, recoveryVersion: 2, phrase: fresh.phrase)
        }
        // The step names the old recovery key (version 1): the reset was not made. The new phrase is not sent to it:
        // it would be a wrong answer, counted against the account, for a reset that never happened.
        var sent = Sent()
        #expect(await prove(pending(1), sent) == .notApplied)
        #expect(await sent.proofs.isEmpty)
        // It names the reset's key: made, and the phrase just made answers it, as a signature that key verifies.
        #expect(await prove(pending(2), sent) == .signedIn(user))
        guard case .phrase(let signature)? = await sent.proofs.first else { Issue.record("no phrase answer"); return }
        #expect(twoStepPhraseVerify(publicKey: try base64urlDecode(value: fresh.envelope.publicKey), userId: userId,
                                    tokenDigest: stepTokenDigest(stepToken: token), signature: try base64urlDecode(value: signature)))
        // The step's reply lost: the reset was made all the same, so the words are shown. Before, this threw the new phrase away with the sign-in.
        sent = Sent()
        let failed = await prove(pending(2), sent, fails: true)
        #expect(failed == .applied)
        #expect(Reset.settle(sent: .unknown, proved: failed) == .show(nil, certain: true))
        // The reset's key, but no phrase method this build can answer with: made, and not answered.
        sent = Sent()
        #expect(await prove(pending(2, [.totp]), sent) == .applied)
        // A step that names no recovery key, or another version: no version to go by, and nothing is sent.
        #expect(await prove(pending(nil), sent) == .unknown)
        #expect(await prove(pending(9), sent) == .unknown)
        #expect(await sent.proofs.isEmpty)
    }

    @Test func aRefusedPasswordMeansNoResetAndNoAnswerAtAllMeansNothing() async {
        let user = user
        func prove(_ failure: Error) async -> Reset.Proved {
            await Auth.proved(probe: { throw failure }, answer: { _, _ in user }, credentialVersion: 4, recoveryVersion: 2, phrase: "")
        }
        #expect(await prove(AuthError.wrongPassword) == .notApplied)
        #expect(await prove(AuthError.message(AuthError.unreachable)) == .unknown)
        #expect(await prove(StepError.lost(StepWords.lostSignIn)) == .unknown)
        #expect(await prove(AuthError.message("Too many tries. Wait a moment, then try again.")) == .unknown)
        // Unknown both ways is the one case the words are shown with a caveat.
        #expect(Reset.settle(sent: .unknown, proved: .unknown) == .show(nil, certain: false))
    }

    @Test func aRotationWhoseReplyWasLostIsJudgedByTheVersionsALaterReplyShows() async throws {
        // The rotation writes credential version 4 over 3 and recovery version 2 over 1. Its reply never arrived.
        let userId = UUID().uuidString.lowercased()
        let fresh = try recoveryCreate(userId: userId, accountKey: randomBytes(length: 32), recoveryVersion: 2, keyVersion: 1)
        let user = user
        func step(_ recoveryVersion: UInt64) -> Auth.ResetProbe {
            var asked = challenge([.totp, .phrase])
            asked.phrase = StepPhrase(userId: userId, recoveryVersion: recoveryVersion, wrappingSalt: fresh.envelope.wrappingSalt)
            return .step(PendingSignIn(origin: "https://step.test", email: "maya@example.org", challenge: asked, exportKey: Data(repeating: 1, count: 64)))
        }
        func settle(_ probe: Auth.ResetProbe, _ sent: Sent = Sent(), fails: Bool = false) async -> Reset.Settled {
            let proved = await Auth.proved(probe: { probe }, answer: { _, proof in await sent.took(proof); if fails { throw StepError.lost(StepWords.lostStep) }; return user },
                                           credentialVersion: 4, recoveryVersion: 2, phrase: fresh.phrase)
            return Reset.settle(sent: .unknown, proved: proved, notMade: StepWords.notRotated)
        }
        // The new versions are visible: it was made. The words are shown, and the step is answered with them: for
        // someone whose only second step is the phrase, dropping them here was a permanent lockout.
        var sent = Sent()
        #expect(await settle(step(2), sent) == .show(user, certain: true))
        #expect(await sent.proofs.count == 1)
        #expect(await settle(session(4, Looked())) == .show(user, certain: true))
        // Made, and the step's answer didn't come back: the words are still shown, as the account's.
        #expect(await settle(step(2), fails: true) == .show(nil, certain: true))
        // The old versions: it was not made, in the rotation's own words, and the new phrase is sent nowhere.
        sent = Sent()
        #expect(await settle(step(1), sent) == .refused(StepWords.notRotated))
        #expect(await sent.proofs.isEmpty)
        #expect(await settle(session(3, Looked())) == .refused(StepWords.notRotated))
        // No reply shows a version: the words are shown all the same, with the caveat.
        let nothing = await Auth.proved(probe: { throw AuthError.message(AuthError.unreachable) }, answer: { _, _ in user }, credentialVersion: 4, recoveryVersion: 2, phrase: fresh.phrase)
        #expect(Reset.settle(sent: .unknown, proved: nothing, notMade: StepWords.notRotated) == .show(nil, certain: false))
        // Only a request that got no answer of the server's own is read this way; a refusal changed nothing and is thrown.
        #expect(Auth.unanswered(StepError.lost(StepWords.lostSaved)))
        #expect(Auth.unanswered(AuthError.message(AuthError.unreachable)))
        #expect(!Auth.unanswered(StepError.refused(.wrong, "That code didn’t work.")))
        #expect(!Auth.unanswered(AuthError.message("That isn’t your password.")))
    }

    @Test func theSignInAfterHeldWordsAnswersOnlyAStepThatNamesThem() async throws {
        let userId = UUID().uuidString.lowercased()
        let fresh = try recoveryCreate(userId: userId, accountKey: randomBytes(length: 32), recoveryVersion: 2, keyVersion: 1)
        let user = user
        func step(_ recoveryVersion: UInt64?, _ methods: [StepMethod] = [.totp, .phrase]) -> Auth.SignIn {
            var asked = challenge(methods)
            asked.phrase = recoveryVersion.map { StepPhrase(userId: userId, recoveryVersion: $0, wrappingSalt: fresh.envelope.wrappingSalt) }
            return .step(PendingSignIn(origin: "https://step.test", email: "maya@example.org", challenge: asked, exportKey: Data(repeating: 1, count: 64)))
        }
        func signedIn(_ taken: Auth.SignIn) -> SessionUser? { if case .signedIn(let who) = taken { who } else { nil } }
        // The step names the held words' recovery key: answered with them, as a signature that key verifies, and signed in.
        let sent = Sent()
        #expect(signedIn(await Auth.holding(step(2), phrase: fresh.phrase, recoveryVersion: 2) { _, proof in await sent.took(proof); return user }) == user)
        guard case .phrase(let signature)? = await sent.proofs.first else { Issue.record("no phrase answer"); return }
        #expect(twoStepPhraseVerify(publicKey: try base64urlDecode(value: fresh.envelope.publicKey), userId: userId,
                                    tokenDigest: stepTokenDigest(stepToken: token), signature: try base64urlDecode(value: signature)))
        // Another key (a rotation that was not made after all), none named, or no phrase method: the step is the
        // person's to answer, and the held words are sent nowhere.
        let unasked = Sent()
        for left in [step(1), step(nil), step(2, [.totp])] {
            #expect(signedIn(await Auth.holding(left, phrase: fresh.phrase, recoveryVersion: 2) { _, proof in await unasked.took(proof); return user }) == nil)
        }
        #expect(await unasked.proofs.isEmpty)
        // The answer didn't come back as a session: the step screen takes over, and nothing is thrown away.
        #expect(signedIn(await Auth.holding(step(2), phrase: fresh.phrase, recoveryVersion: 2) { _, _ in throw StepError.lost(StepWords.lostStep) }) == nil)
        // No step at all: signed in as it was.
        #expect(signedIn(await Auth.holding(.signedIn(user), phrase: fresh.phrase, recoveryVersion: 2) { _, _ in throw StepError.lost("") }) == user)
    }

    @Test func aPhonesOwnRotationMutesTheSignedOutNoticeFromBeforeItsRequestToTheSignInAfter() {
        var change = OwnChange()
        #expect(!change.mutesSessionEnd)
        // Before the request: another request's 401 can arrive ahead of the rotation's own answer.
        change.begin()
        #expect(change.mutesSessionEnd)
        // It failed: a session that ends now is said as usual.
        change.ended()
        #expect(!change.mutesSessionEnd)
        // It went through: muted while the words are on screen, and while the sign-in after them is out.
        change.begin()
        change.hold()
        #expect(change.mutesSessionEnd && change.wordsHeld)
        change.wordsChecked(CheckedWords(userId: "U", origin: "https://hushos.com", recoveryVersion: 4))
        #expect(change.mutesSessionEnd && !change.wordsHeld)
        change.settled()
        #expect(!change.mutesSessionEnd)
    }

    @Test func aSignInEndsWhateverWasHeldAndRecordsTheCheckOnlyForItsOwnWords() {
        func held() -> OwnChange {
            var change = OwnChange()
            change.begin(); change.hold()
            change.wordsChecked(CheckedWords(userId: "U-1", origin: "https://hushos.com", recoveryVersion: 4))
            return change
        }
        // The same account on the same server: its phrase's version is confirmed, and nothing stays muted or held.
        var change = held()
        #expect(change.signedIn(userId: "u-1", origin: "https://hushos.com") == 4)
        #expect(change == OwnChange())
        // Another account signing in on this phone, or the same one on another server, confirms nothing.
        change = held()
        #expect(change.signedIn(userId: "someone-else", origin: "https://hushos.com") == nil)
        change = held()
        #expect(change.signedIn(userId: "u-1", origin: "https://hush.example.org") == nil)
        // A sign-in by another road while words were still on screen: they are no longer held (a stuck hold would mute every later sign-out).
        change = OwnChange()
        change.begin(); change.hold()
        _ = change.signedIn(userId: "u-1", origin: "https://hushos.com")
        #expect(!change.mutesSessionEnd && !change.wordsHeld)
        // Words whose rotation was never confirmed carry no version to record.
        #expect(CheckedWords(userId: "u", origin: "o", recoveryVersion: 0).confirms(userId: "u", origin: "o") == nil)
    }

    @Test func aStepLeftUnansweredIsDroppedAMinuteAfterItsOwnEnd() {
        let pending = PendingSignIn(origin: "https://step.test", email: "maya@example.org", challenge: challenge(), exportKey: Data(repeating: 1, count: 64))
        // 2026-11-13T10:00:00Z, plus the minute.
        #expect(pending.dropAt() == Date(timeIntervalSince1970: 1_794_564_000 + 60))
        // An end that can't be read still ends: the server's five minutes from now, plus the minute.
        var undated = challenge()
        undated.expiresAt = "soon"
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(PendingSignIn(origin: "o", email: "e", challenge: undated, exportKey: Data()).dropAt(now: now) == now.addingTimeInterval(360))
    }
}

/* Password re-checks on this phone, one at a time. */
@Suite struct PasswordTurnTests {
    actor Log {
        var lines: [String] = []
        func add(_ line: String) { lines.append(line) }
    }

    @Test func aSecondPasswordExchangeStartsOnlyOnceTheFirstHasFinished() async {
        // The removal of other devices runs behind the backup codes while the person can open New codes or Change
        // password. Interleaved, the second would start under a session the first is about to change.
        let turn = PasswordTurn()
        let log = Log()
        await turn.enter()
        let second = Task {
            await turn.enter()
            await log.add("second starts")
            await turn.leave()
        }
        let third = Task {
            try? await Task.sleep(for: .milliseconds(20))
            await turn.enter()
            await log.add("third starts")
            await turn.leave()
        }
        try? await Task.sleep(for: .milliseconds(80))
        // Both are waiting: neither ran while the first held its turn.
        #expect(await log.lines.isEmpty)
        await log.add("first ends")
        await turn.leave()
        await second.value
        await third.value
        #expect(await log.lines == ["first ends", "second starts", "third starts"])
        // Free again once everyone has left: the next one does not wait.
        await turn.enter()
        await turn.leave()
    }

    @Test func aCallerCancelledWhileWaitingNeverMakesItsChange() async {
        // Its turn comes after whoever asked has gone: the change is not made late, and the turn goes on to the next.
        let turn = PasswordTurn()
        await turn.enter()
        let waiting = Task { try await PasswordTurn.take(turn) }
        try? await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        await turn.leave()
        let ended = await waiting.result
        #expect(throws: CancellationError.self) { try ended.get() }
        // A waiter that took the turn after all still holds it: given back, so what follows fails here and does not hang.
        if case .success = ended { await turn.leave() }
        try? await PasswordTurn.take(turn)
        await turn.leave()
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

    @Test func aChangeIsMadeOnlyWhenTheServersOwnAnswerSaysSo() throws {
        let json: (String) -> [String: Any] = { (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) ?? [:] }
        // A password change, a rotation, a deletion: `{ "success": true }` and nothing less. An object that is merely
        // an object (a proxy's reply with a 200) must not have the app remember a new password, or wipe the phone.
        try Auth.done(json("{\"success\":true}"), lost: StepWords.lostSaved)
        for body in ["{}", "{\"success\":false}", "{\"success\":1}", "{\"success\":\"true\"}", "{\"error\":\"upstream\"}", "{\"ok\":true}"] {
            #expect(throws: StepError.lost(StepWords.lostDeleted), "\(body)") { try Auth.done(json(body), lost: StepWords.lostDeleted) }
        }
        // A pending app needs its id, its key and its address: a key shown without an id could never be confirmed.
        #expect(TwoStep.enrolment(json("{\"id\":\"f\",\"secret\":\"JBSW\",\"uri\":\"otpauth://totp/x\",\"expiresAt\":\"2026-11-13T10:00:00.000Z\"}")) == TotpEnrolment(id: "f", secret: "JBSW", uri: "otpauth://totp/x"))
        for body in ["{}", "{\"id\":\"f\",\"secret\":\"JBSW\"}", "{\"id\":\"\",\"secret\":\"JBSW\",\"uri\":\"otpauth://totp/x\"}", "{\"id\":\"f\",\"secret\":\"\",\"uri\":\"otpauth://totp/x\"}", "{\"id\":\"f\",\"secret\":\"JBSW\",\"uri\":\"\"}", "{\"id\":7,\"secret\":\"JBSW\",\"uri\":\"u\"}"] {
            #expect(TwoStep.enrolment(json(body)) == nil, "\(body)")
        }
        // Turning off: `removed` true and whether the step is still on, or nothing says it was turned off.
        #expect(TwoStep.removed(json("{\"removed\":true,\"on\":false}")) == false)
        #expect(TwoStep.removed(json("{\"removed\":true,\"on\":true}")) == true)
        for body in ["{}", "{\"removed\":true}", "{\"removed\":false,\"on\":false}", "{\"removed\":1,\"on\":false}", "{\"removed\":true,\"on\":0}", "{\"on\":false}"] {
            #expect(TwoStep.removed(json(body)) == nil, "\(body)")
        }
        // New codes: shown as "your codes" only when they are codes.
        #expect(TwoStep.codes(json("{\"codes\":[\"7KQ2M-9XD4P\"]}")) == ["7KQ2M-9XD4P"])
        for body in ["{}", "{\"codes\":[]}", "{\"codes\":[\"\"]}", "{\"codes\":\"7KQ2M-9XD4P\"}", "{\"codes\":[1,2]}", "{\"backupCodes\":[\"7KQ2M-9XD4P\"]}"] {
            #expect(TwoStep.codes(json(body)) == nil, "\(body)")
        }
    }

    @Test func theLineUnderRemoveMyOtherDevicesNeverNeedsACount() {
        // The box is there whatever the device list said: unknown or none, the line still says what ticking does.
        let general = "Any other device signed in to your account will need to sign in again, and will be asked for the second step."
        #expect(TotpEnrolment.othersLine(nil) == general)
        #expect(TotpEnrolment.othersLine(0) == general)
        #expect(TotpEnrolment.othersLine(1) == "One other device is signed in without the second step. They’ll need to sign in again, and will be asked for it.")
        #expect(TotpEnrolment.othersLine(3) == "3 other devices are signed in without the second step. They’ll need to sign in again, and will be asked for it.")
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
        #expect(words("totp-frozen", "totp") == "Authenticator app paused after many wrong answers")
        // Said by the kind of method: a security key added is not "Authenticator app replaced".
        #expect(words("method-added", "totp") == "Authenticator app replaced")
        #expect(words("method-added", "webauthn") == "Security key added")
        #expect(words("method-added") == "Second-step method added")
        #expect(words("method-removed", "totp") == "Authenticator app removed")
        #expect(words("method-removed", "webauthn") == "Security key removed")
        #expect(words("method-removed") == "Second-step method removed")
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

        @Test func signInSaysItCanAnswerASecondStep() {
            // Without `twoStep: 1` the server answers an account that has the step with update-required: nobody with it could sign in here.
            let body = Auth.finishBody(attemptToken: "attempt", finishRequest: "ke3", device: nil)
            #expect(body["twoStep"] as? Int == 1)
            #expect(body["attemptToken"] as? String == "attempt")
            #expect(body["finishLoginRequest"] as? String == "ke3")
            #expect(body["device"] == nil)
            #expect((Auth.finishBody(attemptToken: "a", finishRequest: "k", device: ["id": "d", "signature": "s"])["device"] as? [String: String]) == ["id": "d", "signature": "s"])
        }

        @Test func aWholeSessionBodyWithoutItsCookieIsNotASignIn() async {
            // The session is its body and its cookie. A reply that lost the cookie on the way hands over nothing: stored as
            // a sign-in, the app would sit signed in with no session.
            let session = "{\"user\":{\"id\":\"u\",\"email\":\"maya@example.org\",\"name\":\"Maya\"},\"envelope\":{\"envelopeVersion\":1,\"keyVersion\":1,\"credentialVersion\":2,\"wrappingSalt\":\"c2FsdA\",\"wrappingNonce\":\"bm9uY2U\",\"encryptedKey\":\"a2V5\"},\"device\":{\"id\":\"d\",\"attached\":false,\"registered\":true}}"
            let error = await answer(StepServer(200, session))
            #expect(error as? StepError == .lost(StepWords.lostStep))
        }

        @Test func everyPasswordChangeWaitsForItsTurn() async {
            // The removal of other devices runs behind the backup codes; a change started meanwhile must not reach the
            // server until it has finished. Each of these sent its first request at once before.
            let server = StepServer(503, "")
            serve(server)
            defer { done() }
            await PasswordTurn.shared.enter()
            let changes: [(String, @Sendable () async -> Void)] = [
                ("/api/auth/security/start", { try? await Auth.changePassword(current: "old password here", new: "new password here") }),
                ("/api/auth/security/start", { _ = try? await Auth.rotateKeysKit(email: "maya@example.org", password: "old password here") }),
                ("/api/auth/delete/start", { try? await Auth.deleteAccount(password: "old password here") }),
                ("/api/auth/devices/reauth", { _ = try? await Devices.removeOthers(password: "old password here") }),
                ("/api/auth/two-step/reauth", { _ = try? await TwoStep.newBackupCodes(password: "old password here", twoStep: nil) }),
            ]
            for (path, change) in changes {
                let before = server.requests.count
                let running = Task { await change() }
                try? await Task.sleep(for: .milliseconds(120))
                #expect(server.requests.count == before, "\(path) went out while another exchange held the turn")
                await PasswordTurn.shared.leave()
                await running.value
                #expect(server.requests.count == before + 1, "\(path)")
                #expect(server.requests.last?.path == path)
                // Each gave its turn back: the next one in the list can be held again.
                try? await Task.sleep(for: .milliseconds(30))
                await PasswordTurn.shared.enter()
            }
            await PasswordTurn.shared.leave()
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
            #expect(unavailable.flatMap { StepOutcome.after($0, methods: [.totp, .backup, .phrase], tried: .totp) } == .again(message: words, field: false, methods: [.backup, .phrase]))
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
