package com.hushos.app.data

import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepPhrase
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.base64urlDecode
import com.hushos.core.randomBytes
import com.hushos.core.recoveryCreate
import com.hushos.core.stepTokenDigest
import com.hushos.core.twoStepPhraseVerify
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Two-step sign-in on the phone (docs/two-step-design.md 4 to 6). What these hold: a reply that is
 * not the server's answer is never a sign-in and never a dead end; each refusal does what its code
 * says, in the server's words; the answer that goes out is the one typed, to the right route; and
 * the recovery phrase leaves the phone only as a signature the account's recovery key verifies.
 */
class TwoStepTest {
    private val token = "t".repeat(43)
    private val all = listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE)

    private fun challenge(methods: List<StepMethod> = all, phrase: StepPhrase? = null, token: String = this.token) =
        StepChallenge(token, methods, "2026-11-13T10:00:00.000Z", phrase)

    /* A server with one answer for every request, and what was asked of it. */
    private class Asked(val method: String, val path: String, val cookie: String?, val body: JSONObject)
    private val servers = mutableListOf<HttpServer>()
    private val asked = mutableListOf<Asked>()
    @Volatile private var answer: Pair<Int, String> = 500 to ""

    private fun serving(status: Int, body: String): Shared.Session {
        answer = status to body
        servers.firstOrNull()?.let { return Shared.Session("http://127.0.0.1:${it.address.port}", "session-token", "user") }
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val sent = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            asked += Asked(exchange.requestMethod, exchange.requestURI.path, exchange.requestHeaders.getFirst("Cookie"),
                runCatching { JSONObject(sent) }.getOrDefault(JSONObject()))
            val (code, text) = answer
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        server.start()
        servers += server
        return Shared.Session("http://127.0.0.1:${server.address.port}", "session-token", "user")
    }

    private fun refusal(message: String, code: String? = null) = JSONObject().put("message", message).apply { code?.let { put("code", it) } }.toString()

    @org.junit.After
    fun stop() = servers.forEach { it.stop(0) }

    // What the step screen does after each way an answer can fail.

    @Test
    fun aWrongAnswerAsksAgainOnTheSameStepWithEveryMethodStillOffered() {
        val said = "That code didn’t work. Codes change every 30 seconds."
        assertEquals(StepOutcome.Again(said, true, all), StepOutcome.after(StepRefused(StepRefusal.WRONG, said), all))
    }

    @Test
    fun anEndedStepGoesBackToThePasswordAndNeverAsksAgain() {
        // Asking again on a token that is over would refuse every answer: a screen nothing can finish.
        val said = "Too many wrong answers. Enter your password again."
        assertEquals(StepOutcome.Over(said), StepOutcome.after(StepRefused(StepRefusal.EXPIRED, said), all))
        val update = "Update HushOS to sign in. This account asks for a second step."
        assertEquals(StepOutcome.Over(update), StepOutcome.after(StepRefused(StepRefusal.UPDATE_REQUIRED, update), all))
        // Something the server said that this build has no rule for ends the step too, with its words.
        assertEquals(StepOutcome.Over("This account is suspended."), StepOutcome.after(StepRefused(StepRefusal.OTHER, "This account is suspended."), all))
        assertEquals(StepOutcome.Over(StepWords.OVER), StepOutcome.after(StepRefused(StepRefusal.OTHER, ""), all))
    }

    @Test
    fun aPausedAppIsNoLongerOfferedButTheOtherMethodsAre() {
        val said = "Your authenticator app is paused on this device. Use a backup code or your recovery phrase."
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.BACKUP, StepMethod.PHRASE)), StepOutcome.after(StepRefused(StepRefusal.FROZEN, said), all))
    }

    @Test
    fun aSpentBudgetOrAServerThatCannotCheckCodesLeavesThePhrase() {
        val limited = "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase."
        assertEquals(StepOutcome.Again(limited, false, listOf(StepMethod.PHRASE)), StepOutcome.after(StepRefused(StepRefusal.LIMITED, limited), all))
        val unavailable = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
        assertEquals(StepOutcome.Again(unavailable, false, listOf(StepMethod.PHRASE)), StepOutcome.after(StepRefused(StepRefusal.UNAVAILABLE, unavailable), all))
        // With no phrase to fall back on, what was offered stays: waiting is the only way, and the field must not vanish.
        val codes = listOf(StepMethod.TOTP, StepMethod.BACKUP)
        assertEquals(StepOutcome.Again(limited, false, codes), StepOutcome.after(StepRefused(StepRefusal.LIMITED, limited), codes))
    }

    @Test
    fun aLostReplyOffersTheSameAnswerAgainAndNoAnswerAtAllKeepsTheStep() {
        assertEquals(StepOutcome.Retry(StepWords.LOST_STEP), StepOutcome.after(LostReply(StepWords.LOST_STEP), all))
        assertEquals(StepOutcome.Again(Auth.UNREACHABLE, false, all), StepOutcome.after(AuthUnreachable(), all))
        // Left the screen: nothing failed, and nothing is said.
        assertNull(StepOutcome.after(kotlinx.coroutines.CancellationException("left"), all))
    }

    // What a person typed, and what goes out for it.

    @Test
    fun aCodeIsSentOnlyWhenItIsSixDigitsAndABackupCodeAsTheServerReadsIt() {
        for (typed in listOf("", "12345", "1234567", "12345a", "１２３４５６"))
            assertEquals(typed, "Enter the 6-digit code from your authenticator app.", StepDraft(StepMethod.TOTP, totp = typed).problem(StepMethod.TOTP))
        // As an autofill or a person spaces it.
        assertNull(StepDraft(StepMethod.TOTP, totp = "123 456").problem(StepMethod.TOTP))
        assertNull(StepDraft(StepMethod.BACKUP, backup = "7kq2m-9xd4p").problem(StepMethod.BACKUP))
        assertEquals("Enter one of your backup codes, 10 characters.", StepDraft(StepMethod.BACKUP, backup = "7KQ2M-9XD4").problem(StepMethod.BACKUP))
        assertEquals("Enter all 24 words of your recovery phrase. 3 so far.", StepDraft(StepMethod.PHRASE, phrase = " abandon  ability\nable ").problem(StepMethod.PHRASE))
    }

    @Test
    fun aMethodNoLongerOfferedGivesWayToTheNextAndNoneIsNone() {
        val draft = StepDraft.of(all)
        assertEquals(StepMethod.TOTP, draft.shown(all))
        // The app was paused: the field becomes the backup code's, not an authenticator field nothing accepts.
        assertEquals(StepMethod.BACKUP, draft.shown(listOf(StepMethod.BACKUP, StepMethod.PHRASE)))
        assertEquals(StepMethod.PHRASE, draft.copy(method = StepMethod.PHRASE).shown(listOf(StepMethod.BACKUP, StepMethod.PHRASE)))
        assertNull(draft.shown(emptyList()))
    }

    @Test
    fun thePhraseGoesOutOnlyAsASignatureTheAccountsRecoveryKeyVerifies() {
        val user = java.util.UUID.randomUUID().toString()
        val made = recoveryCreate(user, randomBytes(32u), 1uL, 1uL)
        val signing = StepPhrase(user, 1uL, made.envelope.wrappingSalt)
        // Typed as people type: capitals, line breaks, stray spaces.
        val draft = StepDraft(StepMethod.PHRASE, phrase = "  " + made.phrase.uppercase().replace(" ", "\n ") + " ")
        val answer = draft.answer(challenge(phrase = signing), StepMethod.PHRASE)
        val signature = (answer.proof as StepProof.Phrase).signature
        val publicKey = base64urlDecode(made.envelope.publicKey)
        assertTrue(twoStepPhraseVerify(publicKey, user, stepTokenDigest(token), base64urlDecode(signature)))
        // For this step only: the same signature proves nothing for another token.
        assertFalse(twoStepPhraseVerify(publicKey, user, stepTokenDigest("u".repeat(43)), base64urlDecode(signature)))
        // Not one word of the phrase is in what is sent.
        val sent = answer.json().toString().lowercase()
        for (word in made.phrase.split(" ").filter { it.length > 3 }) assertFalse(word, sent.contains(word))
    }

    @Test
    fun aMistypedPhraseIsRefusedHereAndAPhraseWithNothingToSignWithIsNotSent() {
        val user = java.util.UUID.randomUUID().toString()
        val made = recoveryCreate(user, randomBytes(32u), 1uL, 1uL)
        val words = made.phrase.split(" ").toMutableList().also { it[3] = if (it[3] == "zoo") "abandon" else "zoo" }
        val signing = StepPhrase(user, 1uL, made.envelope.wrappingSalt)
        val refused = assertThrows(com.hushos.core.CoreException::class.java) { StepDraft(StepMethod.PHRASE, phrase = words.joinToString(" ")).answer(challenge(phrase = signing), StepMethod.PHRASE) }
        // Said beside the field, in the core's own sentence and nothing of its type.
        assertEquals(StepOutcome.Again("That is not a valid recovery phrase. Check each word and try again.", true, all), StepOutcome.after(refused, all))
        val unsigned = assertThrows(AuthFailure::class.java) { StepDraft(StepMethod.PHRASE, phrase = made.phrase).answer(challenge(phrase = null), StepMethod.PHRASE) }
        assertEquals(StepWords.CANNOT_ANSWER, unsigned.message)
    }

    // The step inside a form that changes the account.

    @Test
    fun aChangeCarriesNoStepUntilOneIsAskedAndNothingIsSentUntilTheFieldCanBe() {
        assertEquals(StepUp.Proof.None, StepUp(StepPurpose.PASSWORD).prove())
        val asked = StepUp(StepPurpose.PASSWORD).take(challenge())
        assertEquals("", asked.problem)
        val unready = (asked.prove() as StepUp.Proof.Unready).step
        assertEquals("Enter the 6-digit code from your authenticator app.", unready.problem)
        val ready = unready.typed(unready.draft.copy(totp = "123456")).prove()
        assertEquals(StepUp.Proof.Ready(StepAnswer(token, StepProof.Totp("123456"))), ready)
    }

    @Test
    fun aChangeRefusedForWantOfTheStepAsksForOneAndSaysNothingYet() {
        val (next, step) = StepUp(StepPurpose.DELETE).failed(StepRefused(StepRefusal.REQUIRED, "This needs your second step."))
        assertEquals(StepUp.Next.RENEW, next)
        assertEquals("", step.error)
    }

    @Test
    fun aWrongAnswerStaysOnTheStepAndAnEndedOneAsksForANewOneKeepingWhatWasTyped() {
        val typed = StepUp(StepPurpose.PASSWORD).take(challenge()).let { it.typed(it.draft.copy(totp = "123456")) }
        val (again, wrong) = typed.failed(StepRefused(StepRefusal.WRONG, "That code didn’t work. Codes change every 30 seconds."))
        assertEquals(StepUp.Next.AGAIN, again)
        assertEquals("That code didn’t work. Codes change every 30 seconds.", wrong.problem)
        val (renew, ended) = wrong.failed(StepRefused(StepRefusal.EXPIRED, "This confirmation timed out. Start again."))
        assertEquals(StepUp.Next.RENEW, renew)
        assertEquals("This confirmation timed out. Start again.", ended.error)
        val fresh = ended.take(challenge(token = "n".repeat(43)), keep = true)
        assertEquals("123456", fresh.draft.totp)
        assertEquals("n".repeat(43), (fresh.prove() as StepUp.Proof.Ready).answer.token)
    }

    @Test
    fun aPausedAppAndASpentBudgetNarrowWhatTheFormOffersAndWhatIsNotTheStepsIsTheFormsOwn() {
        val asked = StepUp(StepPurpose.TWO_STEP).take(challenge())
        val (_, frozen) = asked.failed(StepRefused(StepRefusal.FROZEN, "Paused."))
        assertEquals(listOf(StepMethod.BACKUP, StepMethod.PHRASE), frozen.methods)
        assertEquals(StepMethod.BACKUP, frozen.shown)
        val (_, limited) = frozen.failed(StepRefused(StepRefusal.LIMITED, "Too many."))
        assertEquals(listOf(StepMethod.PHRASE), limited.methods)
        for (other in listOf(AuthFailure("The current password is not right."), StepRefused(StepRefusal.SETUP_REQUIRED, "Finish setting up your account first."), LostReply(StepWords.LOST_CHANGE))) {
            val (next, same) = asked.failed(other)
            assertEquals(StepUp.Next.NOT_STEP, next)
            assertEquals(all, same.methods)
        }
    }

    // What Account shows.

    @Test
    fun onlyAnAuthenticatorAddressIsEverOpened() {
        val key = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
        assertNotNull(TotpEnrolment("a", key, "otpauth://totp/HushOS:maya@example.org?secret=$key&issuer=HushOS").link)
        // A server that answers with any other address gets nothing opened by the app.
        for (uri in listOf("https://example.org/otp", "otpauth://hotp/x?secret=$key", "tel:112", "intent://x#Intent;end", "")) assertNull(uri, TotpEnrolment("a", key, uri).link)
        assertEquals("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP", TotpEnrolment("a", key, "").grouped)
    }

    @Test
    fun theCodesLeftSayWhenToMakeMoreAndTheLogStillListsAKindItDoesNotKnow() {
        fun status(left: Int) = TwoStepStatus(true, emptyList(), left, false).codesLeft
        assertEquals("10 of 10 left", status(10))
        assertEquals("3 of 10 left", status(3))
        assertEquals("2 of 10 left. Make a new set soon.", status(2))
        assertEquals("None left. Make a new set.", status(0))
        // Not the settings' shape: nothing is shown as "off" on a guess.
        assertNull(TwoStepStatus.from(JSONObject().put("message", "nope")))
        fun words(kind: String, method: String? = null) = SecurityEvent("e", kind, method, null, null).words
        assertEquals("Signed in with your password and an authenticator code", words("sign-in", "totp"))
        assertEquals("Signed in", words("sign-in"))
        assertEquals("Wrong answer to the second step, with a backup code", words("step-failed", "backup"))
        assertEquals("Security change", words("something-new"))
        assertEquals("Android", SecurityEvent("e", "sign-in", null, "android", null).device)
    }

    // The requests themselves, against a server that answers as the real one does, or as something in the way does.

    @Test
    fun theAnswerGoesToTheStepRouteWithItsTokenAndNoSessionCookie() {
        val session = serving(401, refusal("That code didn’t work. Codes change every 30 seconds.", "step-wrong"))
        assertThrows(StepRefused::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123 456")) }
        val sent = asked.single()
        assertEquals("POST", sent.method)
        assertEquals("/api/auth/login/two-step", sent.path)
        assertEquals(token, sent.body.getString("token"))
        assertEquals("totp", sent.body.getJSONObject("proof").getString("kind"))
        assertEquals("123456", sent.body.getJSONObject("proof").getString("code"))
        // A sign-in has no session yet, and the phones never send one to it.
        // (Origin is set too, as every request's is; the test JVM's HttpURLConnection drops that header, Android's sends it.)
        assertNull(sent.cookie)
    }

    @Test
    fun eachRefusalIsThrownWithItsCodeAndTheServersWords() {
        val cases = listOf(
            Triple(401, "step-wrong", StepRefusal.WRONG), Triple(401, "step-expired", StepRefusal.EXPIRED), Triple(403, "step-frozen", StepRefusal.FROZEN),
            Triple(429, "step-limited", StepRefusal.LIMITED), Triple(409, "update-required", StepRefusal.UPDATE_REQUIRED),
        )
        for ((status, code, refusal) in cases) {
            val session = serving(status, refusal("The server’s words for $code.", code))
            val thrown = assertThrows(code, StepRefused::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
            assertEquals(code, refusal, thrown.refusal)
            assertEquals("The server’s words for $code.", thrown.message)
        }
        // A row the server cannot read is its fault (503 `step-unavailable`): said as it says it, nothing changed, and the phrase is still offered.
        val said = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
        val session = serving(503, refusal(said, "step-unavailable"))
        val thrown = assertThrows(StepRefused::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
        assertEquals(StepRefusal.UNAVAILABLE, thrown.refusal)
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.PHRASE)), StepOutcome.after(thrown, all))
    }

    @Test
    fun aFiveHundredWithoutTheStepsCodeIsALostReplyNeverAnAnswer() {
        // The server's catch-all 503, or a gateway's: sent again, never read as "codes can't be checked" (which
        // would take the code field away) and never as a wrong answer.
        for ((status, body) in listOf(503 to refusal("Authentication is temporarily unavailable. Please try again."), 500 to refusal("Something broke."), 503 to refusal("Try later.", "other"))) {
            val session = serving(status, body)
            val thrown = assertThrows("$status $body", LostReply::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
            assertEquals(StepOutcome.Retry(StepWords.LOST_STEP), StepOutcome.after(thrown, all))
        }
        // At a change too: it may have gone through, so it is not reported either way.
        var session = serving(503, refusal("Authentication is temporarily unavailable. Please try again."))
        assertEquals(StepWords.LOST_CHANGE, assertThrows(LostReply::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }.message)
        // And with the code, a change is refused as the step's, with nothing changed: the form keeps the phrase.
        session = serving(503, refusal("Unavailable.", "step-unavailable"))
        val refused = assertThrows(StepRefused::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }
        val (next, step) = StepUp(StepPurpose.PASSWORD).take(challenge()).failed(refused)
        assertEquals(StepUp.Next.AGAIN, next)
        assertEquals(listOf(StepMethod.PHRASE), step.methods)
    }

    @Test
    fun theAddresssOwnLimitTakesNoMethodAway() {
        // A 429 without the step's code says nothing about the step: a code that was fine is still worth sending.
        val session = serving(429, refusal("Too many attempts. Please try again in 15 minutes."))
        val thrown = assertThrows(StepRefused::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
        assertEquals(StepOutcome.Again("Too many attempts. Please try again in 15 minutes.", false, all), StepOutcome.after(thrown, all))
    }

    @Test
    fun aReplyThatIsNotTheServersAnswerIsLostNeverASignIn() {
        // A 200 with neither an account nor a step, a proxy's page, a cut-off body, a gateway's error,
        // and a second step in place of the session: none signs anyone in, and each offers the answer again.
        val replies = listOf(
            200 to "{}", 200 to "", 200 to "<html><body>Sign in to Wi-Fi</body></html>", 200 to "{\"user\":{\"id\":\"u\"",
            200 to "{\"user\":{\"id\":\"u\",\"email\":\"maya@example.org\"}}", 502 to "<html>Bad gateway</html>", 503 to "",
            200 to "{\"twoStep\":{\"token\":\"$token\",\"methods\":[\"totp\"],\"expiresAt\":\"2026-11-13T10:00:00.000Z\"}}",
        )
        for ((status, body) in replies) {
            val session = serving(status, body)
            val thrown = assertThrows("$status $body", LostReply::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
            assertEquals(StepOutcome.Retry(StepWords.LOST_STEP), StepOutcome.after(thrown, all))
        }
    }

    @Test
    fun thePasswordsReplyIsTheSessionTheStepOrLostAndItsOwnRefusalsStayItsOwn() {
        fun read(status: Int, body: String) = Auth.signInReply(Auth.RawReply(status, body, runCatching { JSONObject(body) }.getOrDefault(JSONObject()), null, null), StepWords.LOST_SIGN_IN)
        val step = read(200, "{\"twoStep\":{\"token\":\"$token\",\"methods\":[\"totp\",\"webauthn\",\"backup\"],\"expiresAt\":\"2026-11-13T10:00:00.000Z\"}}")
        // A security key is not something this build answers with.
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP), step?.methods)
        for (body in listOf("{}", "", "<html>", "{\"user\":{\"id\":\"u\",\"email\":\"m@example.org\"}}")) {
            val lost = assertThrows(body, LostReply::class.java) { read(200, body) }
            assertEquals(StepWords.LOST_SIGN_IN, lost.message)
        }
        // An older build's sign-in on an account with the step: told to update, in the server's words, never left waiting.
        val update = assertThrows(StepRefused::class.java) { read(409, refusal("Update HushOS to sign in. This account asks for a second step.", "update-required")) }
        assertEquals(StepRefusal.UPDATE_REQUIRED, update.refusal)
        assertEquals(StepOutcome.Over("Update HushOS to sign in. This account asks for a second step."), StepOutcome.after(update, all))
        // A wrong password and the limiter's 429 are the password's own refusals, not a step's.
        for (status in listOf(401, 429)) {
            val own = assertThrows(AuthFailure::class.java) { read(status, refusal("The server’s words.")) }
            assertFalse(own is StepRefused)
            assertEquals("The server’s words.", own.message)
        }
    }

    @Test
    fun aStepForAChangeIsAskedForUnderTheSessionAndAnAccountWithoutOneGetsNone() {
        var session = serving(200, JSONObject().put("token", token).put("methods", org.json.JSONArray(listOf("totp", "backup"))).put("expiresAt", "2026-11-13T10:00:00.000Z").toString())
        val step = TwoStep.challenge(session, StepPurpose.MASTER_KEY)
        assertEquals(token, step?.token)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP), step?.methods)
        val sent = asked.single()
        assertEquals("/api/auth/two-step/challenge", sent.path)
        assertEquals("master-key", sent.body.getString("purpose"))
        assertEquals("hushos-session=session-token", sent.cookie)
        // The step is off for this account (409), or this server has two-step off and it never had one (501).
        for (status in listOf(409, 501)) {
            session = serving(status, refusal("Two-step sign-in is off for this account."))
            assertNull("$status", TwoStep.challenge(session, StepPurpose.PASSWORD))
        }
        // Something in the way: not "no step", or the change would go without one and be refused again and again.
        session = serving(200, "<html>")
        assertThrows(LostReply::class.java) { TwoStep.challenge(session, StepPurpose.PASSWORD) }
    }

    @Test
    fun aChangesRefusalIsTheStepsOnlyWhenTheServerNamesOneOfItsCodes() {
        var session = serving(403, refusal("This needs your second step.", "two-step"))
        assertEquals(StepRefusal.REQUIRED, assertThrows(StepRefused::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }.refusal)
        session = serving(429, refusal("Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.", "step-limited"))
        assertEquals(StepRefusal.LIMITED, assertThrows(StepRefused::class.java) { Auth.callAt(session, "/api/auth/delete/finish", JSONObject(), whole = true) }.refusal)
        // The password limiter's 429 is not the step's: the form shows it as its own error and keeps every method.
        session = serving(429, refusal("Too many attempts. Please try again in 15 minutes."))
        val own = assertThrows(AuthFailure::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }
        assertFalse(own is StepRefused)
        assertEquals("Too many attempts. Please try again in 15 minutes.", own.message)
        // A session that ended is still a session that ended.
        session = serving(401, refusal("Sign in to change your password."))
        assertThrows(NotAuthenticated::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }
    }

    @Test
    fun aChangeWhoseReplyWasLostIsNotReportedAsDone() {
        var session = serving(200, "<html>Maintenance</html>")
        assertThrows(LostReply::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }
        session = serving(200, "")
        assertThrows(LostReply::class.java) { TwoStep.confirmAuthenticator(session, "f", "123456") }
    }

    @Test
    fun aServerWithTwoStepOffShowsNothingAndOneThatFailsIsNotReadAsOff() {
        var session = serving(501, refusal("Two-step sign-in isn’t available on this server."))
        assertNull(TwoStep.status(session))
        session = serving(200, """{"on":true,"methods":[{"id":"m","kind":"totp","name":null,"createdAt":"2026-11-12T09:30:00.000Z","lastUsedAt":null,"synced":false}],"backupCodesLeft":9,"totpFrozen":true}""")
        val on = TwoStep.status(session)
        assertEquals(true, on?.on)
        assertEquals(true, on?.totpFrozen)
        assertEquals(9, on?.backupCodesLeft)
        assertEquals("m", on?.app?.id)
        assertNull(on?.app?.lastUsedAt)
        for ((status, body) in listOf(500 to refusal("Authentication is temporarily unavailable. Please try again."), 200 to "<html>", 502 to "")) {
            session = serving(status, body)
            assertThrows("$status", AuthFailure::class.java) { TwoStep.status(session) }
        }
    }

    @Test
    fun confirmingTheAppGivesTheCodesOnceAndSaysWhenTheSetupRanOut() {
        var session = serving(200, """{"backupCodes":["7KQ2M-9XD4P","AAAAA-BBBBB"]}""")
        assertEquals(listOf("7KQ2M-9XD4P", "AAAAA-BBBBB"), TwoStep.confirmAuthenticator(session, "factor", "123 456"))
        assertEquals("/api/auth/two-step/totp/factor/confirm", asked.single().path)
        assertEquals("123456", asked.single().body.getString("code"))
        // Replacing an app that is already on gives no new codes: null, not an empty list shown as "your codes".
        session = serving(200, "{}")
        assertNull(TwoStep.confirmAuthenticator(session, "factor", "123456"))
        session = serving(400, refusal("That code didn’t work. Codes change every 30 seconds.", "step-wrong"))
        assertEquals(StepRefusal.WRONG, assertThrows(StepRefused::class.java) { TwoStep.confirmAuthenticator(session, "factor", "000000") }.refusal)
        session = serving(404, refusal("This setup timed out. Start again."))
        assertEquals("This setup timed out. Start again.", assertThrows(SetupTimedOut::class.java) { TwoStep.confirmAuthenticator(session, "factor", "123456") }.message)
    }
}
