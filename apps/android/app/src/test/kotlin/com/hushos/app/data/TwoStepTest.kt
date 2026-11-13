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

    /* The clock since boot, which a JVM test has none of: a step arrives at `now`. */
    private var now = 50_000L
    @org.junit.Before
    fun clock() { uptime = { now } }

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
    fun aSpentBudgetWithdrawsTheCodeMethodsTogether() {
        // One 15-minute budget covers the app's codes and the backup codes: offering the other one would only be refused too.
        val limited = "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase."
        for (tried in listOf(StepMethod.TOTP, StepMethod.BACKUP))
            assertEquals(StepOutcome.Again(limited, false, listOf(StepMethod.PHRASE)), StepOutcome.after(StepRefused(StepRefusal.LIMITED, limited), all, tried))
        // With no phrase to fall back on nothing is left, and the screen says so rather than show a field every answer to which is refused.
        assertEquals(StepOutcome.Again(limited, false, emptyList()), StepOutcome.after(StepRefused(StepRefusal.LIMITED, limited), listOf(StepMethod.TOTP, StepMethod.BACKUP), StepMethod.TOTP))
    }

    @Test
    fun aMethodTheServerCannotCheckIsWithdrawnAloneAndTheOthersStayOffered() {
        // `step-unavailable` is per method: the app's secret and the backup codes can sit under different server keys.
        // Withdrawing both for one would send someone to their recovery phrase while a backup code still works.
        val said = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
        val refused = StepRefused(StepRefusal.UNAVAILABLE, said)
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.BACKUP, StepMethod.PHRASE)), StepOutcome.after(refused, all, StepMethod.TOTP))
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.TOTP, StepMethod.PHRASE)), StepOutcome.after(refused, all, StepMethod.BACKUP))
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.TOTP)), StepOutcome.after(refused, listOf(StepMethod.TOTP, StepMethod.BACKUP), StepMethod.BACKUP))
        // Unlike a spent budget, which is one for both kinds of code.
        assertEquals(listOf(StepMethod.PHRASE), StepOutcome.left(all, StepRefusal.LIMITED, StepMethod.BACKUP))
        // The same inside a form: the method on screen is the one that was sent.
        val asked = StepUp(StepPurpose.PASSWORD).take(challenge()).let { it.typed(it.draft.copy(method = StepMethod.BACKUP)) }
        val (next, step) = asked.failed(refused)
        assertEquals(StepUp.Next.AGAIN, next)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.PHRASE), step.methods)
        assertEquals(StepMethod.TOTP, step.shown)
    }

    @Test
    fun aSecondPasswordExchangeStartsOnlyOnceTheFirstHasFinished() {
        // The removal of other devices runs behind the backup codes while the person can open New codes or Change
        // password. Interleaved, the second would start under a session the first is about to change.
        val log = java.util.Collections.synchronizedList(mutableListOf<String>())
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val first = Thread { Auth.passwordTurn { holding.countDown(); release.await(); log += "first ends" } }.apply { isDaemon = true; start() }
        holding.await()
        val second = Thread { Auth.passwordTurn { log += "second starts" } }.apply { isDaemon = true; start() }
        // The second is waiting: it did not run while the first held its turn.
        try {
            second.join(150)
            assertTrue(second.isAlive)
            assertTrue(log.isEmpty())
        } finally { release.countDown() }
        first.join(); second.join()
        assertEquals(listOf("first ends", "second starts"), log)
        // A failure inside gives the turn back.
        assertThrows(AuthFailure::class.java) { Auth.passwordTurn<Unit> { throw AuthFailure("no") } }
        assertEquals("free", Auth.passwordTurn { "free" })
    }

    @Test
    fun aCallerCancelledWhileWaitingNeverMakesItsChangeAndTheLineMovesOn() {
        // These calls block a thread, so cancelling the coroutine that made one does not stop it. Left waiting, it
        // would make its change (new codes, a removal, a rotation) once its turn came, after whoever asked had gone.
        val ran = java.util.Collections.synchronizedList(mutableListOf<String>())
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val releaseAgain = java.util.concurrent.CountDownLatch(1)
        // Whatever fails below, the turn is given back: a held turn would hang every later test that needs one.
        try {
        val first = Thread { Auth.passwordTurn { holding.countDown(); release.await() } }.apply { isDaemon = true; start() }
        holding.await()
        val gone = java.util.concurrent.atomic.AtomicBoolean(false)
        val thrown = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val second = Thread {
            try { Auth.cancellable({ gone.get() }) { Auth.passwordTurn { ran += "second" } } } catch (error: Throwable) { thrown.set(error) }
        }.apply { isDaemon = true; start() }
        Thread.sleep(80)
        val third = Thread { Auth.passwordTurn { ran += "third" } }.apply { isDaemon = true; start() }
        Thread.sleep(80)
        gone.set(true)
        // It gives its place up at once, while the first still holds the turn.
        second.join(2_000)
        assertFalse(second.isAlive)
        assertTrue(thrown.get() is java.util.concurrent.CancellationException)
        assertNull(StepOutcome.after(thrown.get()!!, all))
        assertTrue(ran.isEmpty())
        release.countDown()
        first.join(2_000); third.join(2_000)
        // The one behind it is not left waiting for a place nobody holds.
        assertEquals(listOf("third"), ran)

        // Cancelled at the very moment its turn comes: asked once more at the head, it still does not run.
        val holdingAgain = java.util.concurrent.CountDownLatch(1)
        val holder = Thread { Auth.passwordTurn { holdingAgain.countDown(); releaseAgain.await() } }.apply { isDaemon = true; start() }
        holdingAgain.await()
        thrown.set(null)
        val late = Thread {
            try { Auth.cancellable({ releaseAgain.count == 0L }) { Auth.passwordTurn { ran += "late" } } } catch (error: Throwable) { thrown.set(error) }
        }.apply { isDaemon = true; start() }
        Thread.sleep(120)
        releaseAgain.countDown()
        holder.join(2_000); late.join(2_000)
        assertTrue(thrown.get() is java.util.concurrent.CancellationException)
        assertEquals(listOf("third"), ran)
        } finally { release.countDown(); releaseAgain.countDown() }
        assertEquals("free", Auth.passwordTurn { "free" })
    }

    @Test
    fun aWaitThatEndsAnyOtherWayGivesItsPlaceUpToo() {
        // The probe itself failing, or the thread interrupted: left in the line, its ticket reached the head with nobody
        // behind it, and every later password change on the phone waited for ever.
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val thrown = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        try {
            val holder = Thread { Auth.passwordTurn { holding.countDown(); release.await() } }.apply { isDaemon = true; start() }
            holding.await()
            val broken = Thread {
                try { Auth.cancellable({ throw IllegalStateException("the probe failed") }) { Auth.passwordTurn { } } } catch (error: Throwable) { thrown.set(error) }
            }.apply { isDaemon = true; start() }
            broken.join(2_000)
            assertTrue(thrown.get() is IllegalStateException)
            val interrupted = Thread { try { Auth.passwordTurn { } } catch (error: Throwable) { thrown.set(error) } }.apply { isDaemon = true; start() }
            Thread.sleep(120)
            interrupted.interrupt()
            interrupted.join(2_000)
            assertTrue(thrown.get() is InterruptedException)
            release.countDown()
            holder.join(2_000)
        } finally { release.countDown() }
        // The turn is free: the next one runs at once.
        val next = java.util.concurrent.Executors.newSingleThreadExecutor()
        try { assertEquals("free", next.submit<String> { Auth.passwordTurn { "free" } }.get(2, java.util.concurrent.TimeUnit.SECONDS)) } finally { next.shutdownNow() }
    }

    @Test
    fun aChangeThatWaitsTooLongForItsTurnGivesUpWithNothingSent() {
        // The one ahead can take minutes against a server that answers slowly (a rotation makes several requests).
        // Whoever waits behind it is told so after a minute, and its place goes: it must not run later, unasked.
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val ran = java.util.concurrent.atomic.AtomicInteger()
        Auth.turnWaitMillis = 150
        try {
            val holder = Thread { Auth.passwordTurn { holding.countDown(); release.await() } }.apply { isDaemon = true; start() }
            holding.await()
            val late = assertThrows(AuthFailure::class.java) { Auth.passwordTurn { ran.incrementAndGet() } }
            assertEquals("This took too long. Please try again.", late.message)
            release.countDown()
            holder.join(2_000)
        } finally { release.countDown(); Auth.turnWaitMillis = 60_000 }
        assertEquals(0, ran.get())
        val next = java.util.concurrent.Executors.newSingleThreadExecutor()
        try { assertEquals("free", next.submit<String> { Auth.passwordTurn { "free" } }.get(2, java.util.concurrent.TimeUnit.SECONDS)) } finally { next.shutdownNow() }
    }

    @Test
    fun everyPasswordChangeWaitsForItsTurn() {
        // The removal of other devices runs behind the backup codes; a change started meanwhile must send nothing
        // until it has finished. Each of these sent its first request at once before it took the turn.
        val session = serving(503, "")
        val changes = listOf<Pair<String, () -> Unit>>(
            "/api/auth/security/start" to { Auth.changePasswordAt(session, "old password here", "new password here", null) },
            "/api/auth/security/start" to { Auth.rotateKeysAt(session, "old password here", null) },
            "/api/auth/delete/start" to { Auth.deleteAccountAt(session, "old password here", null) },
            "/api/auth/devices/reauth" to { Auth.removeOtherDevicesAt(session, "old password here") },
            "/api/auth/two-step/reauth" to { TwoStep.newBackupCodes(session, "old password here", null) },
            "/api/auth/two-step/reauth" to { TwoStep.removeMethod(session, "factor", "old password here", null) },
            "/api/auth/two-step/reauth" to { TwoStep.startAuthenticator(session, "old password here") },
        )
        for ((path, change) in changes) {
            val holding = java.util.concurrent.CountDownLatch(1)
            val release = java.util.concurrent.CountDownLatch(1)
            val holder = Thread { Auth.passwordTurn { holding.countDown(); release.await() } }.apply { isDaemon = true; start() }
            holding.await()
            val before = asked.size
            val running = Thread { runCatching { change() } }.apply { isDaemon = true; start() }
            try {
                running.join(200)
                assertTrue("$path finished while another exchange held the turn", running.isAlive)
                assertEquals("$path went out while another exchange held the turn", before, asked.size)
            } finally { release.countDown() }
            holder.join(); running.join(10_000)
            assertEquals(path, before + 1, asked.size)
            assertEquals(path, asked.last().path)
            assertEquals("hushos-session=session-token", asked.last().cookie)
        }
    }

    // What survives a failure after the server has already made a change.

    private val maya = SessionUser("u", "Maya", "maya@example.org", 3uL)

    @Test
    fun onceTheChangeIsTakenTheNewWordsAreShownWhateverTheSignInDoes() {
        // The old phrase is dead the moment the server takes the change, and the new one is only in memory. Dropped because
        // the sign-in after it failed (no network, a 429, a step that didn't pass), the account has no phrase anyone has seen.
        for (proved in listOf(Reset.Proved.Applied, Reset.Proved.Unknown, Reset.Proved.NotApplied))
            assertEquals("$proved", Reset.Settled.Show(null, certain = true), Reset.settle(Reset.Sent.Accepted, proved))
        assertEquals(Reset.Settled.Show(maya, certain = true), Reset.settle(Reset.Sent.Accepted, Reset.Proved.SignedIn(maya)))
    }

    @Test
    fun theNewWordsAreWithheldOnlyWhenTheServerAnsweredARefusal() {
        // The request left and nothing of the server's came back. A look that found the account as it was is not proof
        // that nothing changed: the commit can land a second later, and words that were dropped can't be shown again.
        // Before, this said "not changed" and threw the only copy of what may be the account's phrase away.
        assertEquals(Reset.Settled.Show(null, certain = false), Reset.settle(Reset.Sent.Unknown, Reset.Proved.NotApplied))
        assertEquals(Reset.Settled.Show(null, certain = false), Reset.settle(Reset.Sent.Unknown, Reset.Proved.Unknown))
        // Something showed it was made: the words are the account's.
        assertEquals(Reset.Settled.Show(maya, certain = true), Reset.settle(Reset.Sent.Unknown, Reset.Proved.SignedIn(maya)))
        assertEquals(Reset.Settled.Show(null, certain = true), Reset.settle(Reset.Sent.Unknown, Reset.Proved.Applied))
        // The server answered, and refused: nothing changed, whatever a look afterwards showed, and only then is that said.
        for (proved in listOf(Reset.Proved.Unknown, Reset.Proved.NotApplied, Reset.Proved.Applied))
            assertEquals(Reset.Settled.Refused("This link has expired."), Reset.settle(Reset.Sent.Refused("This link has expired."), proved))
        assertEquals("This link has expired. ${StepWords.NOT_RESET}", Reset.refusal("This link has expired.", StepWords.NOT_RESET))
        assertEquals(StepWords.NOT_ROTATED, Reset.refusal(" ", StepWords.NOT_ROTATED))
        assertEquals("Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again.", StepWords.NOT_RESET)
        assertEquals("Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again.", StepWords.NOT_ROTATED)
    }

    @Test
    fun onlyA4xxInTheServersOwnWordsIsAnAnsweredRefusal() {
        assertEquals(Reset.Sent.Accepted, Reset.sent(200, JSONObject("""{"user":{"id":"u"}}""")))
        // A 200 that is not the account (a proxy's page parsed as nothing), and any 5xx: nothing says either way.
        assertEquals(Reset.Sent.Unknown, Reset.sent(200, JSONObject()))
        assertEquals(Reset.Sent.Unknown, Reset.sent(200, JSONObject("""{"user":"u"}""")))
        assertEquals(Reset.Sent.Unknown, Reset.sent(503, JSONObject().put("message", "Authentication is temporarily unavailable. Please try again.")))
        assertEquals(Reset.Sent.Unknown, Reset.sent(502, JSONObject()))
        // A 4xx in the server's words is a refusal: the old phrase still works, and the new words are never shown.
        assertEquals(Reset.Sent.Refused("That recovery phrase isn’t right."), Reset.sent(401, JSONObject().put("message", "That recovery phrase isn’t right.")))
        // A 4xx with nothing of the server's in it (something in the way) is not one: the words are kept.
        assertEquals(Reset.Sent.Unknown, Reset.sent(429, JSONObject()))
        assertEquals(Reset.Sent.Unknown, Reset.sent(403, JSONObject().put("message", "  ")))
        // A rotation's own answer is `{ success: true }`.
        assertEquals(Reset.Sent.Accepted, Reset.sent(200, JSONObject("""{"success":true}""")) { it.opt("success") == true })
        assertEquals(Reset.Sent.Unknown, Reset.sent(200, JSONObject("""{"error":"upstream"}""")) { it.opt("success") == true })
    }

    @Test
    fun whatSecurityFinishAnsweredToARotationKeepsTheWordsUnlessItRefused() {
        fun reply(status: Int, body: String) = Auth.SessionReply(status, body, runCatching { JSONObject(body) }.getOrDefault(JSONObject()))
        assertEquals(Reset.Sent.Accepted, Auth.finishSent(reply(200, """{"success":true}""")))
        // No reply at all, a gateway's error, a 200 that is not the server's answer: the rotation may have been made.
        assertEquals(Reset.Sent.Unknown, Auth.finishSent(null))
        assertEquals(Reset.Sent.Unknown, Auth.finishSent(reply(502, "<html>Bad gateway</html>")))
        assertEquals(Reset.Sent.Unknown, Auth.finishSent(reply(200, "{}")))
        assertEquals(Reset.Sent.Unknown, Auth.finishSent(reply(429, "")))
        // The server answered, and refused: the step's own refusals go to the form's step fields with their code,
        // an ended session to sign-in, and anything else is a refusal in the server's words.
        assertEquals(StepRefusal.WRONG, assertThrows(StepRefused::class.java) { Auth.finishSent(reply(401, refusal("That code didn’t work.", "step-wrong"))) }.refusal)
        assertEquals(StepRefusal.REQUIRED, assertThrows(StepRefused::class.java) { Auth.finishSent(reply(403, refusal("This needs your second step.", "two-step"))) }.refusal)
        assertThrows(NotAuthenticated::class.java) { Auth.finishSent(reply(401, refusal("Sign in again."))) }
        assertEquals(Reset.Sent.Refused("The password is not right."), Auth.finishSent(reply(400, refusal("The password is not right."))))
    }

    @Test
    fun theSignInAfterAChangeIsTriedOnceMoreAndTheBetterAnswerStands() {
        fun proving(vararg answers: Reset.Proved): Pair<Reset.Proved, Int> {
            val left = answers.toMutableList()
            var made = 0
            return Reset.prove { made++; if (left.isEmpty()) Reset.Proved.Unknown else left.removeAt(0) } to made
        }
        // The step path failing leaves "applied": tried again, and signed in the second time.
        assertEquals(Reset.Proved.SignedIn(maya) to 2, proving(Reset.Proved.Applied, Reset.Proved.SignedIn(maya)))
        // Still no session the second time: the change stays shown as made, so the words are the account's.
        assertEquals(Reset.Proved.Applied to 2, proving(Reset.Proved.Applied, Reset.Proved.Unknown))
        assertEquals(Reset.Proved.Applied to 2, proving(Reset.Proved.Unknown, Reset.Proved.Applied))
        // The account as it was at the first look, and the change landed by the second.
        assertEquals(Reset.Proved.SignedIn(maya) to 2, proving(Reset.Proved.NotApplied, Reset.Proved.SignedIn(maya)))
        // Signed in: not tried again.
        assertEquals(Reset.Proved.SignedIn(maya) to 1, proving(Reset.Proved.SignedIn(maya), Reset.Proved.Unknown))
    }

    /* A probe that met a session sealed under `salt`, and whether it was then opened or ended. */
    private class Session(salt: String?, user: SessionUser, fails: Boolean = false) {
        var opened = 0
        var ended = 0
        val probe = Auth.Probe.Session(salt, open = { opened++; if (fails) throw AuthFailure("Signed in, but the session was not returned.") else user }, end = { ended++ })
    }

    @Test
    fun signingInIsNotEvidenceOnlyTheChangesOwnSaltIs() {
        // Someone who "reset" to the password they already had signs in fine against the unchanged account, and a
        // rotation keeps the password. Read as made, they would be told their old phrase is dead when it is the only one.
        val unchanged = Session("the-envelope-as-it-was", maya)
        val proved = Auth.proved({ unchanged.probe }, { _, _ -> error("no step") }, envelopeSalt = "this-change", recoverySalt = "its-recovery-key", freshPhrase = "")
        assertEquals(Reset.Proved.NotApplied, proved)
        // The session was only asked for to look: never stored on the phone, and ended on the server.
        assertEquals(0 to 1, unchanged.opened to unchanged.ended)
        // And still the words are shown, with the caveat: the look is not proof (theNewWordsAreWithheldOnly…).
        assertEquals(Reset.Settled.Show(null, certain = false), Reset.settle(Reset.Sent.Unknown, proved))
        // The envelope this change sealed: made, and this is the sign-in.
        val changed = Session("this-change", maya)
        assertEquals(Reset.Proved.SignedIn(maya), Auth.proved({ changed.probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", ""))
        assertEquals(1 to 0, changed.opened to changed.ended)
        // Made, but the session could not be stored: still made.
        assertEquals(Reset.Proved.Applied, Auth.proved({ Session("this-change", maya, fails = true).probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", ""))
        // No salt in the reply: nothing is known, and the session is not kept.
        val bare = Session(null, maya)
        assertEquals(Reset.Proved.Unknown, Auth.proved({ bare.probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", ""))
        assertEquals(0 to 1, bare.opened to bare.ended)
    }

    @Test
    fun aRotationThatFindsTheAccountAsItWasKeepsThePersonInTheAppWithBothPhrasesKept() {
        // A rotation keeps the password, so the look signs in whether it landed or not. On the account as it was, the
        // person was signed in a moment ago and still is: they stay in, and the words are shown with "keep both"
        // (the rotation may land a second later). Ended instead, they were thrown out of an account nothing changed.
        val asItWas = Session("the-envelope-as-it-was", maya)
        val proved = Auth.proved({ asItWas.probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", "", keepsSession = true)
        assertEquals(Reset.Proved.Unconfirmed(maya), proved)
        assertEquals(1 to 0, asItWas.opened to asItWas.ended)
        assertEquals(Reset.Settled.Show(maya, certain = false), Reset.settle(Reset.Sent.Unknown, proved))
        // The server's own answer stands when there was one.
        assertEquals(Reset.Settled.Show(maya, certain = true), Reset.settle(Reset.Sent.Accepted, proved))
        // Signed in already: not looked at a second time.
        var looks = 0
        assertEquals(proved, Reset.prove { looks++; proved })
        assertEquals(1, looks)
        // A reset never keeps such a session: holding the link and the phrase does not sign anyone in to an unchanged account.
        val reset = Session("the-envelope-as-it-was", maya)
        assertEquals(Reset.Proved.NotApplied, Auth.proved({ reset.probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", ""))
        assertEquals(0 to 1, reset.opened to reset.ended)
        // A session that could not be stored is not kept, and one with no salt says nothing even for a rotation.
        val unstored = Session("the-envelope-as-it-was", maya, fails = true)
        assertEquals(Reset.Proved.NotApplied, Auth.proved({ unstored.probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", "", keepsSession = true))
        assertEquals(1, unstored.ended)
        assertEquals(Reset.Proved.Unknown, Auth.proved({ Session(null, maya).probe }, { _, _ -> error("no step") }, "this-change", "its-recovery-key", "", keepsSession = true))
    }

    @Test
    fun aVersionOneHigherIsNotThisChangeAndItsStepIsNotAnswered() {
        // Another device changed the account at the same moment: its recovery key is also "one more than before", but it
        // is not the one made here. Compared by number, the new phrase was sent to it as a wrong answer, and the words
        // were shown as the account's when they are nobody's.
        val userId = "0d8f3a52-5a0e-4a6a-9a3e-6a5b4b1f2c11"
        val fresh = recoveryCreate(userId, randomBytes(32u), 2uL, 1uL)
        val theirs = recoveryCreate(userId, randomBytes(32u), 2uL, 1uL)
        fun pending(salt: String?, version: ULong = 2uL, methods: List<StepMethod> = listOf(StepMethod.TOTP, StepMethod.PHRASE)) =
            PendingSignIn("http://step.test", "maya@example.org", challenge(methods, salt?.let { StepPhrase(userId, version, it) }), ByteArray(64))
        fun prove(step: PendingSignIn, answer: (PendingSignIn, StepProof) -> SessionUser) =
            Auth.proved({ Auth.Probe.Step(step) }, answer, envelopeSalt = "this-change", recoverySalt = fresh.envelope.wrappingSalt, freshPhrase = fresh.phrase)

        var asked = 0
        assertEquals(Reset.Proved.NotApplied, prove(pending(theirs.envelope.wrappingSalt, version = 2uL)) { _, _ -> asked++; maya })
        assertEquals(0, asked)
        // The step names the recovery key made here, whatever number it carries: the phrase just made answers it, as a signature that key verifies.
        var sent: StepProof? = null
        assertEquals(Reset.Proved.SignedIn(maya), prove(pending(fresh.envelope.wrappingSalt, version = 9uL)) { _, proof -> sent = proof; maya })
        assertTrue(twoStepPhraseVerify(base64urlDecode(fresh.envelope.publicKey), userId, stepTokenDigest(token), base64urlDecode((sent as StepProof.Phrase).signature)))
        // The step's reply lost, refused, or nothing at all: the change was made all the same, so the words are the account's.
        for (failure in listOf(LostReply(StepWords.LOST_STEP), StepRefused(StepRefusal.WRONG, "That recovery phrase isn’t right."), AuthUnreachable(), IllegalStateException("x"))) {
            val proved = prove(pending(fresh.envelope.wrappingSalt)) { _, _ -> throw failure }
            assertEquals("$failure", Reset.Proved.Applied, proved)
            assertEquals(Reset.Settled.Show(null, certain = true), Reset.settle(Reset.Sent.Unknown, proved))
        }
        // This change's key, but no phrase method this build can answer with: made, and not answered.
        assertEquals(Reset.Proved.Applied, prove(pending(fresh.envelope.wrappingSalt, methods = listOf(StepMethod.TOTP))) { _, _ -> error("not asked") })
        // A step that names no recovery key: nothing to go by, and nothing is sent.
        assertEquals(Reset.Proved.Unknown, prove(pending(null)) { _, _ -> error("not asked") })
    }

    @Test
    fun aRefusedPasswordOrNoAnswerAtAllStillShowsTheWords() {
        fun prove(probe: () -> Auth.Probe) = Auth.proved(probe, { _, _ -> maya }, "this-change", "its-recovery-key", "")
        assertEquals(Reset.Proved.NotApplied, prove { throw WrongPassword() })
        for (failure in listOf(AuthUnreachable(), LostReply(StepWords.LOST_SIGN_IN), AuthFailure("Too many tries. Wait a moment, then try again.", 429)))
            assertEquals("$failure", Reset.Proved.Unknown, prove { throw failure })
        assertEquals(Reset.Settled.Show(null, certain = false), Reset.settle(Reset.Sent.Unknown, prove { throw WrongPassword() }))
    }

    @Test
    fun aRotationsWordsAreHandedBackEvenWhenThisPhoneCannotRememberTheNewKey() {
        // The write of what the phone remembers comes after the last request. If it throws (a full disk, a keystore that
        // refuses), the rotation is made all the same, and the phrase must still reach the screen.
        val userId = "0d8f3a52-5a0e-4a6a-9a3e-6a5b4b1f2c11"
        val fresh = recoveryCreate(userId, randomBytes(32u), 2uL, 1uL)
        val memory = com.hushos.core.deviceRemember(userId, randomBytes(32u), 2uL, 4uL, java.util.UUID.randomUUID().toString())
        val made = Auth.ResetMade(userId, fresh.phrase, JSONObject().put("recoveryVersion", 2).put("wrappingSalt", fresh.envelope.wrappingSalt), Reset.Sent.Accepted, "this-change", fresh.envelope.wrappingSalt, memory)
        var tried = 0
        val keys = Auth.rotated(made, Reset.Settled.Show(null, certain = true)) { tried++; throw java.io.IOException("No space left on device") }
        assertEquals(1, tried)
        assertEquals(fresh.phrase, keys.phrase)
        assertEquals(2L, keys.recoveryVersion)
        assertTrue(keys.certain)
        // Nothing is remembered for a rotation nothing confirmed, or one whose own sign-in has written it already.
        tried = 0
        assertFalse(Auth.rotated(made, Reset.Settled.Show(null, certain = false)) { tried++ }.certain)
        assertEquals(maya, Auth.rotated(made, Reset.Settled.Show(maya, certain = true)) { tried++ }.user)
        assertEquals(0, tried)
        // An answered refusal is the only thing thrown: the server's why, then that nothing changed.
        val refused = assertThrows(AuthFailure::class.java) { Auth.rotated(made, Reset.Settled.Refused("Too many attempts. Please try again in 15 minutes.")) { tried++ } }
        assertEquals("Too many attempts. Please try again in 15 minutes. ${StepWords.NOT_ROTATED}", refused.message)
    }

    @Test
    fun theSignInAfterHeldWordsAnswersOnlyAStepThatNamesThem() {
        val userId = "0d8f3a52-5a0e-4a6a-9a3e-6a5b4b1f2c11"
        val fresh = recoveryCreate(userId, randomBytes(32u), 2uL, 1uL)
        val held = fresh.envelope.wrappingSalt
        fun step(salt: String?, methods: List<StepMethod> = listOf(StepMethod.TOTP, StepMethod.PHRASE)) = Auth.SignIn.Step(PendingSignIn("http://step.test", "maya@example.org",
            challenge(methods, salt?.let { StepPhrase(userId, 2uL, it) }), ByteArray(64)))
        // The step names the held words' recovery key: answered with them, as a signature that key verifies, and signed in.
        var sent: StepProof? = null
        val signedIn = Auth.holding(step(held), fresh.phrase, held) { _, proof -> sent = proof; maya }
        assertEquals(maya, (signedIn as Auth.SignIn.SignedIn).user)
        assertTrue(twoStepPhraseVerify(base64urlDecode(fresh.envelope.publicKey), userId, stepTokenDigest(token), base64urlDecode((sent as StepProof.Phrase).signature)))
        // Another key at the same version (a rotation that was not made after all), none named, no phrase method, or
        // no salt held: the step is the person's to answer, and the held words are sent nowhere.
        // (Counted, not thrown: a failed answer is swallowed and the step handed on, which would hide a phrase that was sent.)
        var asked = 0
        val another = recoveryCreate(userId, randomBytes(32u), 2uL, 1uL).envelope.wrappingSalt
        for (left in listOf(step(another), step(null), step(held, listOf(StepMethod.TOTP)))) assertTrue(Auth.holding(left, fresh.phrase, held) { _, _ -> asked++; maya } === left)
        val unheld = step("")
        assertTrue(Auth.holding(unheld, fresh.phrase, "") { _, _ -> asked++; maya } === unheld)
        assertEquals(0, asked)
        // The answer didn't come back as a session: the step screen takes over, and nothing is thrown away.
        val failed = step(held)
        assertTrue(Auth.holding(failed, fresh.phrase, held) { _, _ -> throw LostReply(StepWords.LOST_STEP) } === failed)
        // No step at all: signed in as it was.
        val plain = Auth.SignIn.SignedIn(maya)
        assertTrue(Auth.holding(plain, fresh.phrase, held) { _, _ -> error("not asked") } === plain)
    }

    @Test
    fun aPhonesOwnChangeMutesTheSignedOutNoticeFromBeforeItsRequestToTheSignInAfter() {
        var change = OwnChange()
        assertFalse(change.mutesSessionEnd)
        // Before the request: another request's 401 can arrive ahead of the change's own answer.
        change = change.begin()
        assertTrue(change.mutesSessionEnd)
        // It failed: a session that ends now is said as usual.
        change = change.ended()
        assertFalse(change.mutesSessionEnd)
        // It went through: muted while the words are on screen, and while the sign-in after them is out.
        change = change.begin().hold()
        assertTrue(change.mutesSessionEnd && change.wordsHeld && !change.underWay)
        change = change.wordsChecked(CheckedWords("U", "https://hushos.com", 4))
        assertTrue(change.mutesSessionEnd && !change.wordsHeld)
        change = change.settled()
        assertFalse(change.mutesSessionEnd)
        // The check outlives the mute: it is recorded at the sign-in that follows.
        assertEquals(4L, change.checked?.recoveryVersion)
        // A new password has no words to hold: muted across the sign-in after it, then not.
        change = OwnChange().begin().signInNext()
        assertTrue(change.mutesSessionEnd)
        assertFalse(change.settled().mutesSessionEnd)
    }

    @Test
    fun aSignInEndsWhateverWasHeldAndRecordsTheCheckOnlyForItsOwnWords() {
        val held = OwnChange().begin().hold().wordsChecked(CheckedWords("U-1", "https://hushos.com", 4))
        // The same account on the same server: its phrase's version is confirmed, and nothing stays muted or held.
        assertEquals(OwnChange() to 4L, held.signedIn("u-1", "https://hushos.com"))
        // Another account signing in on this phone, or the same one on another server, confirms nothing.
        assertEquals(OwnChange() to null, held.signedIn("someone-else", "https://hushos.com"))
        assertEquals(OwnChange() to null, held.signedIn("u-1", "https://hush.example.org"))
        // A sign-in by another road while words were still on screen: they are no longer held (a stuck hold would mute every later sign-out).
        assertFalse(OwnChange().begin().hold().signedIn("u-1", "https://hushos.com").first.mutesSessionEnd)
        // Words whose change was never confirmed carry no version to record.
        assertNull(CheckedWords("u", "o", 0).confirms("u", "o"))
    }

    @Test
    fun aStepLastsSixMinutesFromWhenItArrivedWhateverTheDateOnThePhoneSays() {
        // Counted against the step's own `expiresAt` (the server's wall clock), a phone whose date is set seven minutes
        // fast found every step over before it was shown, and nobody with the step could sign in on it.
        now = 50_000
        for (expiresAt in listOf("2026-11-13T10:00:00.000Z", "1999-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "soon")) {
            val pending = PendingSignIn("https://step.test", "maya@example.org", StepChallenge(token, all, expiresAt, null), ByteArray(64))
            assertEquals(expiresAt, 360_000L, pending.dropIn())
            assertEquals(expiresAt, 1L, pending.dropIn(now = 50_000L + 359_999))
            // The server's five minutes and one more, and then it is over.
            assertEquals(expiresAt, 0L, pending.dropIn(now = 50_000L + 360_000))
            assertTrue(pending.dropIn(now = 50_000L + 400_000) < 0)
        }
        // Each step counts from its own arrival.
        now = 80_000
        assertEquals(350_000L, PendingSignIn("o", "e", challenge(), ByteArray(0)).dropIn(now = 90_000))
    }

    @Test
    fun signInSaysItCanAnswerASecondStep() {
        // Without `twoStep: 1` the server answers an account that has the step with update-required: nobody with it could sign in here.
        val body = Auth.finishBody("attempt", "ke3", null)
        assertEquals(1, body.get("twoStep"))
        assertEquals("attempt", body.getString("attemptToken"))
        assertEquals("ke3", body.getString("finishLoginRequest"))
        assertFalse(body.has("device"))
        assertEquals("d", Auth.finishBody("a", "k", JSONObject().put("id", "d").put("signature", "s")).getJSONObject("device").getString("id"))
    }

    @Test
    fun aWholeSessionBodyWithoutItsCookieIsNotASignIn() {
        // The session is its body and its cookie. A reply that lost the cookie on the way hands over nothing: taken as
        // a sign-in, it failed later with "Signed in, but the session was not returned" and no way to send the answer again.
        val whole = """{"user":{"id":"u","email":"maya@example.org","name":"Maya"},"envelope":{"envelopeVersion":1,"keyVersion":1,"credentialVersion":2,"wrappingSalt":"c2FsdA","wrappingNonce":"bm9uY2U","encryptedKey":"a2V5"},"device":{"id":"d","attached":false,"registered":true}}"""
        val session = serving(200, whole)
        val lost = assertThrows(LostReply::class.java) { Auth.answerStepAt(session.origin, token, StepProof.Totp("123456")) }
        assertEquals(StepOutcome.Retry(StepWords.LOST_STEP), StepOutcome.after(lost, all))
        val password = assertThrows(LostReply::class.java) { Auth.signInReply(Auth.RawReply(200, whole, JSONObject(whole), null, null), StepWords.LOST_SIGN_IN) }
        assertEquals(StepWords.LOST_SIGN_IN, password.message)
        // With its cookie, the same body is the session (null: nothing more to answer).
        assertNull(Auth.signInReply(Auth.RawReply(200, whole, JSONObject(whole), "s3ss", null), StepWords.LOST_SIGN_IN))
        assertNull(Auth.signInReply(Auth.RawReply(200, whole, JSONObject(whole), "s3ss", null), StepWords.LOST_STEP, answering = true))
    }

    @Test
    fun whenTheWaysRanOutAfterRefusalsTheFormDoesNotSayToUpdate() {
        // A spent budget on an account whose step offers no phrase here: updating HushOS would change nothing.
        val (_, spent) = StepUp(StepPurpose.PASSWORD).take(challenge(listOf(StepMethod.TOTP, StepMethod.BACKUP))).failed(StepRefused(StepRefusal.LIMITED, "Too many wrong codes."))
        assertTrue(spent.methods.isEmpty())
        assertEquals(StepWords.NO_WAY_LEFT, (spent.prove() as StepUp.Proof.Unready).step.error)
        // Nothing this build knows was offered at all: that is the one an update fixes.
        assertEquals(StepWords.CANNOT_ANSWER, (StepUp(StepPurpose.PASSWORD).take(challenge(emptyList())).prove() as StepUp.Proof.Unready).step.error)
    }

    @Test
    fun replacingTheAppNeverRemovesDevicesAndWhatAChangeMadeIsKeptOrReadAgain() {
        val codes = TwoStep.Confirmed.TurnedOn(listOf("7KQ2M-9XD4P"))
        // Only turning the step on with the box ticked removes the other devices. Replacing shows no box, and its
        // default (ticked) or a value left from an earlier visit signed every other device out unasked.
        assertTrue(TwoStepFlow.removesOthers(codes, signOutOthers = true, replacing = false))
        assertFalse(TwoStepFlow.removesOthers(codes, signOutOthers = true, replacing = true))
        assertFalse(TwoStepFlow.removesOthers(TwoStep.Confirmed.Replaced, signOutOthers = true, replacing = true))
        assertFalse(TwoStepFlow.removesOthers(TwoStep.Confirmed.Replaced, signOutOthers = true, replacing = false))
        assertFalse(TwoStepFlow.removesOthers(codes, signOutOthers = false, replacing = false))

        val out = TwoStepFlow().started()
        assertTrue(out.pending)
        // The codes are kept the moment they arrive, and the request is no longer out.
        assertEquals(TwoStepFlow(codes = listOf("7KQ2M-9XD4P")), out.confirmed(Result.success(codes), replacing = false))
        assertEquals("Authenticator app replaced.", out.confirmed(Result.success(TwoStep.Confirmed.Replaced), replacing = true).finished)
        // "Replaced" for a step that was being turned on is not the server's answer to that: nothing is claimed, and the settings are read again.
        val odd = out.confirmed(Result.success(TwoStep.Confirmed.Replaced), replacing = false)
        assertEquals(TwoStepFlow(error = StepWords.LOST_TURNED_ON, reread = 1), odd)
        // A lost reply: said, and the settings read again to show which it was.
        val lost = out.confirmed(Result.failure(LostReply(StepWords.LOST_APP_ADDED)), replacing = false)
        assertEquals(TwoStepFlow(error = StepWords.LOST_APP_ADDED, reread = 1), lost)
        // The setup ran out: back to the start, with the server's why, and the old key off the screen.
        val app = TotpEnrolment("factor", "JBSWY3DPEHPK3PXP", "otpauth://totp/HushOS")
        val timedOut = out.enrolled(app).started().confirmed(Result.failure(SetupTimedOut("This setup timed out. Start again.")), replacing = false)
        assertEquals(TwoStepFlow(error = "This setup timed out. Start again."), timedOut)
        // A wrong code keeps the key on screen for another try.
        assertEquals(app, out.enrolled(app).started().confirmed(Result.failure(StepRefused(StepRefusal.WRONG, "That code didn’t work.")), replacing = false).enrolment)

        // Turning off or making codes with the reply lost: nothing says what the account now is, so it is read again.
        assertEquals(1, out.failed(LostReply(StepWords.LOST_TURNED_OFF), StepWords.LOST_TURNED_OFF).reread)
        assertEquals(1, out.failed(LostReply(StepWords.LOST_NEW_CODES), StepWords.LOST_NEW_CODES).reread)
        // So is a dropped connection or a gateway's 502: the change may have gone through all the same.
        assertEquals(1, out.failed(java.io.IOException("connection reset"), "Couldn't reach the server.").reread)
        assertEquals(1, out.confirmed(Result.failure(java.io.IOException("connection reset")), replacing = false).reread)
        // A refusal changed nothing: nothing is read again, and the step's own fields say why (no words for the form).
        assertEquals(TwoStepFlow(), out.failed(StepRefused(StepRefusal.WRONG, "That code didn’t work."), null))
        assertEquals("Two-step sign-in is off.", out.removed(on = false).finished)
        assertEquals("Authenticator app removed.", out.removed(on = true).finished)
        assertEquals(listOf("A", "B"), out.newCodes(listOf("A", "B")).codes)

        // Codes nobody has seen survive a page being opened or left: the server made them already, and nothing else
        // shows them. Before, leaving the page while "Making" was out and opening another dropped them.
        val unseen = out.newCodes(listOf("A", "B"))
        assertEquals(unseen, unseen.cleared())
        assertTrue(unseen.codesReplace)
        assertFalse(out.confirmed(Result.success(codes), replacing = false).codesReplace)
        assertEquals(codes.backupCodes, out.confirmed(Result.success(codes), replacing = false).cleared().codes)
        // A request still out is not cleared either: its answer has to land.
        assertEquals(out, out.cleared())
        // Only Done forgets them, and the settings are read again then.
        assertEquals(TwoStepFlow(reread = 1), unseen.seen())
        // An error or a finished change with nothing to show is cleared as before.
        assertEquals(TwoStepFlow(reread = 1), odd.cleared())
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
        // Nothing of the phrase is in what is sent: the token, the kind, and a 64-byte signature, with no other field
        // to carry a word. (Not a search for the words: "nature" is in "signature", and a random phrase has it now and then.)
        val sent = answer.json()
        assertEquals(setOf("token", "proof"), sent.keys().asSequence().toSet())
        assertEquals(setOf("kind", "signature"), sent.getJSONObject("proof").keys().asSequence().toSet())
        assertEquals(token, sent.getString("token"))
        assertEquals("phrase", sent.getJSONObject("proof").getString("kind"))
        assertEquals(64, base64urlDecode(sent.getJSONObject("proof").getString("signature")).size)
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
        assertEquals("Authenticator app paused after many wrong answers", words("totp-frozen", "totp"))
        // Said by the kind of method: a security key added is not "Authenticator app replaced".
        assertEquals("Authenticator app replaced", words("method-added", "totp"))
        assertEquals("Security key added", words("method-added", "webauthn"))
        assertEquals("Second-step method added", words("method-added"))
        assertEquals("Authenticator app removed", words("method-removed", "totp"))
        assertEquals("Security key removed", words("method-removed", "webauthn"))
        assertEquals("Second-step method removed", words("method-removed"))
        assertEquals("Security change", words("something-new"))
        assertEquals("Android", SecurityEvent("e", "sign-in", null, "android", null).device)
    }

    @Test
    fun aChangeIsMadeOnlyWhenTheServersOwnAnswerSaysSo() {
        // A password change, a rotation, a deletion: `{ "success": true }` and nothing less. An object that is merely
        // an object (a proxy's reply with a 200) must not have the app remember a new password, or wipe the phone.
        Auth.done(JSONObject("""{"success":true}"""), StepWords.LOST_SAVED)
        for (body in listOf("{}", """{"success":false}""", """{"success":1}""", """{"success":"true"}""", """{"error":"upstream"}""", """{"ok":true}"""))
            assertEquals(body, StepWords.LOST_DELETED, assertThrows(LostReply::class.java) { Auth.done(JSONObject(body), StepWords.LOST_DELETED) }.message)
        // A pending app needs its id, its key and its address: a key shown without an id could never be confirmed.
        assertEquals(TotpEnrolment("f", "JBSW", "otpauth://totp/x"), TwoStep.enrolment(JSONObject("""{"id":"f","secret":"JBSW","uri":"otpauth://totp/x","expiresAt":"2026-11-13T10:00:00.000Z"}""")))
        for (body in listOf("{}", """{"id":"f","secret":"JBSW"}""", """{"id":"","secret":"JBSW","uri":"otpauth://totp/x"}""", """{"id":"f","secret":"","uri":"otpauth://totp/x"}""", """{"id":"f","secret":"JBSW","uri":""}""", """{"id":7,"secret":"JBSW","uri":"u"}"""))
            assertNull(body, TwoStep.enrolment(JSONObject(body)))
        // Turning off: `removed` true and whether the step is still on, or nothing says it was turned off.
        assertEquals(false, TwoStep.removed(JSONObject("""{"removed":true,"on":false}""")))
        assertEquals(true, TwoStep.removed(JSONObject("""{"removed":true,"on":true}""")))
        for (body in listOf("{}", """{"removed":true}""", """{"removed":false,"on":false}""", """{"removed":1,"on":false}""", """{"removed":true,"on":0}""", """{"on":false}"""))
            assertNull(body, TwoStep.removed(JSONObject(body)))
        // New codes: shown as "your codes" only when they are codes.
        assertEquals(listOf("7KQ2M-9XD4P"), TwoStep.codes(JSONObject("""{"codes":["7KQ2M-9XD4P"]}""")))
        for (body in listOf("{}", """{"codes":[]}""", """{"codes":[""]}""", """{"codes":"7KQ2M-9XD4P"}""", """{"codes":[1,2]}""", """{"backupCodes":["7KQ2M-9XD4P"]}"""))
            assertNull(body, TwoStep.codes(JSONObject(body)))
    }

    @Test
    fun theLineUnderRemoveMyOtherDevicesNeverNeedsACount() {
        // The box is there whatever the device list said: unknown or none, the line still says what ticking does.
        val general = "Any other device signed in to your account will need to sign in again, and will be asked for the second step."
        assertEquals(general, TotpEnrolment.othersLine(null))
        assertEquals(general, TotpEnrolment.othersLine(0))
        assertEquals("One other device is signed in without the second step. They’ll need to sign in again, and will be asked for it.", TotpEnrolment.othersLine(1))
        assertEquals("3 other devices are signed in without the second step. They’ll need to sign in again, and will be asked for it.", TotpEnrolment.othersLine(3))
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
        assertEquals(StepOutcome.Again(said, false, listOf(StepMethod.BACKUP, StepMethod.PHRASE)), StepOutcome.after(thrown, all, StepMethod.TOTP))
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
        // And with the code, a change is refused as the step's, with nothing changed: the form keeps the other methods.
        session = serving(503, refusal("Unavailable.", "step-unavailable"))
        val refused = assertThrows(StepRefused::class.java) { Auth.callAt(session, "/api/auth/security/finish", JSONObject(), whole = true) }
        val (next, step) = StepUp(StepPurpose.PASSWORD).take(challenge()).failed(refused)
        assertEquals(StepUp.Next.AGAIN, next)
        assertEquals(listOf(StepMethod.BACKUP, StepMethod.PHRASE), step.methods)
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
        // The step is off for this account (409). The route never answers 501: it does not look at the server's switch.
        for (status in listOf(409)) {
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
    fun confirmingTheAppIsOnlyEverOneOfTheServersTwoAnswers() {
        var session = serving(200, """{"backupCodes":["7KQ2M-9XD4P","AAAAA-BBBBB"]}""")
        assertEquals(TwoStep.Confirmed.TurnedOn(listOf("7KQ2M-9XD4P", "AAAAA-BBBBB")), TwoStep.confirmAuthenticator(session, "factor", "123 456"))
        assertEquals("/api/auth/two-step/totp/factor/confirm", asked.single().path)
        assertEquals("123456", asked.single().body.getString("code"))
        session = serving(200, """{"replaced":true}""")
        assertEquals(TwoStep.Confirmed.Replaced, TwoStep.confirmAuthenticator(session, "factor", "123456"))
        // Anything else with a 200 says nothing: told "replaced" (or shown an empty list of codes), someone would
        // believe their new app is on when the server never said so.
        val notAnswers = listOf(
            "{}", """{"replaced":false}""", """{"replaced":1}""", """{"replaced":"true"}""", """{"backupCodes":[]}""", """{"backupCodes":[""]}""",
            """{"backupCodes":"7KQ2M-9XD4P"}""", """{"backupCodes":["7KQ2M-9XD4P"],"replaced":true}""", """{"error":"upstream"}""", """{"success":true}""",
        )
        for (body in notAnswers) {
            session = serving(200, body)
            val lost = assertThrows(body, LostReply::class.java) { TwoStep.confirmAuthenticator(session, "factor", "123456") }
            assertEquals("The server’s answer didn’t arrive, so HushOS can’t tell whether your authenticator app was added. Check before you try again.", lost.message)
        }
        session = serving(400, refusal("That code didn’t work. Codes change every 30 seconds.", "step-wrong"))
        assertEquals(StepRefusal.WRONG, assertThrows(StepRefused::class.java) { TwoStep.confirmAuthenticator(session, "factor", "000000") }.refusal)
        session = serving(404, refusal("This setup timed out. Start again."))
        assertEquals("This setup timed out. Start again.", assertThrows(SetupTimedOut::class.java) { TwoStep.confirmAuthenticator(session, "factor", "123456") }.message)
    }
}
