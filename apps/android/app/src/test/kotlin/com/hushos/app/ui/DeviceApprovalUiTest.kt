package com.hushos.app.ui

import com.hushos.app.data.ApprovalAnswering
import com.hushos.app.data.ApprovalServer
import com.hushos.app.data.ApprovalWire
import com.hushos.app.data.AskPhase
import com.hushos.app.data.Auth
import com.hushos.app.data.AuthUnreachable
import com.hushos.app.data.DeviceApprovals
import com.hushos.app.data.DeviceEnrolment
import com.hushos.app.data.LostReply
import com.hushos.app.data.Problems
import com.hushos.app.data.SignInStep
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepOutcome
import com.hushos.app.data.StepRefused
import com.hushos.app.data.StepWords
import com.hushos.app.data.uptime
import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalQr
import com.hushos.core.deviceSigningCreate
import com.hushos.core.deviceStepCode
import com.hushos.core.turnOnCodeDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * What a screen holds while a request to another device is out, and while one is being answered
 * (`DeviceAskModel`, `ApprovalAnswer`): nothing is asked until a press, a request let go is not
 * looked at again or answered with, a pending answer waits on the same request, an approval whose
 * answer nothing judged (no reply, a lost one, the address's limit) is kept and sent again as the
 * same request with nothing new asked, one the step refused is let go, a second press
 * sends nothing twice, and the sheet closes saying what happened. Waiting for the other device
 * holds nothing up: only a request of the sheet's own on its way does. The request that turns the
 * method on is opened by Answer, approved on a press with nothing scanned or typed, and the code
 * this phone drew for it then stays up until Done; an approval whose answer went missing (no reply,
 * a page that is not the server's, a server error) keeps the sheet on the request as unsettled, and
 * the next press sends the same code with no list read again; the server's own refusal ends it. The
 * requests themselves are `DeviceApprovalTest`'s; the server is the same one, in memory.
 */
class DeviceApprovalUiTest {
    @org.junit.Before
    fun clock() { uptime = { 50_000L } }

    private suspend fun waitFor(what: String, met: () -> Boolean) {
        repeat(600) { if (met()) return; delay(5) }
        fail("Never happened: $what")
    }

    private fun request(server: ApprovalServer) = DeviceAskModel.Request(server.wire(session = null), ApprovalServer.TOKEN, "login", ApprovalServer.random32())

    /* The requests that made one (not the answering phone's list, which shares the path). */
    private fun made(server: ApprovalServer) = server.calls("/api/auth/approvals").count { it.method == "POST" }

    // Asking.

    @Test
    fun nothingIsAskedUntilBeginAndARequestLetGoIsNeitherLookedAtNorAnsweredWith(): Unit = runBlocking {
        val server = ApprovalServer()
        val model = DeviceAskModel(this, { "Pixel 9" }, every = 5)
        // Holding one, as a screen that merely opened does, asks nothing.
        delay(20)
        assertTrue(model.idle)
        assertTrue(server.calls.isEmpty())
        var approved = 0
        model.begin(request(server), approved = { approved++ }, failed = { fail("$it") })
        assertEquals(AskPhase.Starting, model.phase)
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        assertEquals(1, made(server))
        server.open()
        waitFor("the code") { model.phase is AskPhase.Code }
        // Let go (another way was chosen, the screen left): nothing of it is shown, and nothing looks again.
        model.stop()
        assertTrue(model.idle)
        assertNull(model.answer)
        delay(30)
        val looks = server.calls.size
        // Approved after it was let go: nobody answers a step with it.
        server.set("approved")
        delay(60)
        assertEquals(looks, server.calls.size)
        assertEquals(0, approved)
        assertTrue(model.idle)
    }

    @Test
    fun aPendingAnswerWaitsOnTheSameRequestAndAnEndedOneIsAskedAgainOnlyByAPress(): Unit = runBlocking {
        val server = ApprovalServer()
        val model = DeviceAskModel(this, { "Pixel 9" }, every = 5)
        val answers = mutableListOf<StepAnswer>()
        model.begin(request(server), failed = { fail("$it") }, approved = { answer ->
            answers += answer
            // The first answer arrives where the approval has not landed: asked again, and never said as a failure.
            if (answers.size == 1) throw StepRefused(StepRefusal.PENDING, "Waiting for your other device.", 409)
        })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        server.open()
        waitFor("the code") { model.phase is AskPhase.Code }
        assertTrue(answers.isEmpty())
        server.set("approved")
        waitFor("the second answer") { answers.size == 2 }
        assertEquals(AskPhase.Approved, model.phase)
        assertEquals(StepAnswer(ApprovalServer.TOKEN, StepProof.Device(server.requestId)), answers[1])
        // A form's change that came back pending waits on the same request again: no second request is made.
        model.resume()
        waitFor("the third answer") { answers.size == 3 }
        assertEquals(1, made(server))
        // Over without an approval: said, and nothing more is asked until a press asks again.
        val ended = ApprovalServer()
        var heard = 0
        model.begin(request(ended), approved = { heard++ }, failed = { fail("$it") })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        ended.set("ended", "refused")
        waitFor("the end") { model.phase is AskPhase.Ended }
        assertEquals(AskPhase.Ended("Your other device didn’t approve this."), model.phase)
        delay(40)
        assertEquals(1, made(ended))
        assertEquals(0, heard)
        model.stop()
    }

    @Test
    fun aRequestThatCouldNotBeMadeAndAnAnswerWhoseReplyWasLostAreHeardWithNothingLeftOut(): Unit = runBlocking {
        val refusing = ApprovalServer()
        refusing.refusesStart = 429 to """{"message":"You’ve asked your other devices too often today.","code":"device-limited"}"""
        val model = DeviceAskModel(this, { "Pixel 9" }, every = 5)
        val failures = mutableListOf<Throwable>()
        model.begin(request(refusing), approved = { fail("approved") }, failed = { failures += it })
        waitFor("the refusal") { failures.isNotEmpty() }
        assertEquals(StepRefusal.DEVICE_LIMITED, (failures.single() as StepRefused).refusal)
        assertTrue(model.idle)
        assertNull(model.answer)
        // Asked too often from this address before anything was approved: there is no approval to keep, and nothing to send again.
        refusing.refusesStart = 429 to """{"message":"Too many attempts. Please try again in 15 minutes."}"""
        var unmade: StepOutcome? = null
        model.begin(request(refusing), approved = { fail("approved") }, failed = { unmade = model.answerFailed(it, methods) })
        waitFor("the limit") { unmade != null }
        assertEquals(StepOutcome.Again("Too many attempts. Please try again in 15 minutes.", false, methods), unmade)
        assertTrue(model.idle)
        assertNull(model.approved)
        // Approved, and the step's answer got no reply: heard as that, with the approval still standing and the same answer kept to send again.
        val server = ApprovalServer()
        failures.clear()
        model.begin(request(server), approved = { throw LostReply(StepWords.LOST_STEP) }, failed = { failures += it })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        server.open()
        server.set("approved")
        waitFor("the lost reply") { failures.isNotEmpty() }
        assertTrue(failures.single() is LostReply)
        assertEquals(AskPhase.Approved, model.phase)
        assertEquals(StepAnswer(ApprovalServer.TOKEN, StepProof.Device(server.requestId)), model.answer)
        model.stop()
    }

    private val methods = listOf(StepMethod.DEVICE, StepMethod.TOTP, StepMethod.BACKUP)
    private val challenge = StepChallenge(ApprovalServer.TOKEN, methods, "2026-11-14T10:05:00.000Z", null, null, false, false)

    /* No key is offered in these steps: a sheet that is asked anyway fails the test. */
    private val noSheet = object : com.hushos.app.data.KeySheet {
        override suspend fun assertion(request: com.hushos.core.StepKeyRequest): com.hushos.core.KeyAssertion? = throw AssertionError("no key was offered")
        override suspend fun registration(creation: com.hushos.core.KeyCreation): com.hushos.core.KeyRegistration? = throw AssertionError("no key was being added")
    }

    /* The step's own route (`login/two-step`) over HTTP, as `Auth.answerStepAt` reaches it: what it answers, and each body it was sent. */
    private val stepBodies: MutableList<org.json.JSONObject> = java.util.Collections.synchronizedList(mutableListOf())
    @Volatile private var stepReply: Pair<Int, String> = 500 to ""
    private var stepServer: com.sun.net.httpserver.HttpServer? = null

    private fun stepRoute(): String {
        val made = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        made.createContext("/api/auth/login/two-step") { exchange ->
            stepBodies += org.json.JSONObject(exchange.requestBody.readBytes().toString(Charsets.UTF_8))
            val (code, text) = stepReply
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        made.start()
        stepServer = made
        return "http://127.0.0.1:${made.address.port}"
    }

    @org.junit.After
    fun stopStepRoute() { stepServer?.stop(0) }

    private fun refusal(message: String, code: String? = null) = org.json.JSONObject().put("message", message).apply { code?.let { put("code", it) } }.toString()

    @Test
    fun anApprovalWhoseAnswerNothingJudgedIsKeptAndGoesAgainAsTheSameRequestWithNothingNewAsked(): Unit = runBlocking {
        val live = stepRoute()
        // A port nothing listens on: no reply at all.
        val dead = java.net.ServerSocket(0).use { "http://127.0.0.1:${it.localPort}" }
        val limit = "Too many attempts. Please try again in 15 minutes."
        // Where the first answer went, what came back, and the words the screen already has for it.
        val failures = listOf(
            Triple(dead, 0 to "", Problems.OFFLINE),
            Triple(live, 503 to refusal("Authentication is temporarily unavailable. Please try again."), StepWords.LOST_STEP),
            Triple(live, 502 to "<html>Bad gateway</html>", StepWords.LOST_STEP),
            Triple(live, 429 to refusal(limit), limit),
        )
        for ((origin, reply, words) in failures) {
            val server = ApprovalServer()
            val model = DeviceAskModel(this, { "Pixel 9" }, every = 5)
            stepBodies.clear()
            stepReply = reply
            val outcomes = mutableListOf<StepOutcome?>()
            // As the sign-in wires it: the approval answers the step by itself, and what a failure means is the request's to settle.
            model.begin(request(server), approved = { answer -> Auth.answerStepAt(origin, answer.token, answer.proof) }, failed = { outcomes += model.answerFailed(it, methods) })
            waitFor("the QR code") { model.phase is AskPhase.Waiting }
            server.open()
            server.set("approved")
            waitFor("the answer's failure") { outcomes.isNotEmpty() }
            val held = StepAnswer(ApprovalServer.TOKEN, StepProof.Device(server.requestId))
            // Kept: still approved, the same request id, said in the failure's own words, with one press to send it again.
            assertEquals(words, StepOutcome.Retry(words), outcomes.single())
            assertEquals(words, AskPhase.Approved, model.phase)
            assertEquals(words, held, model.approved)
            var step = SignInStep(challenge).after(outcomes.single(), model.approved)
            assertEquals(words, step.notice)
            assertEquals("Try again", step.button(busy = false, ask = model.phase))
            assertTrue(words, step.pressable(busy = false, ask = model.phase))
            // The press sends that answer and no other. It fails the same way again: kept still.
            val pressed = step.pressed(noSheet) as SignInStep.Pressed.Send
            assertEquals(words, held, pressed.answer)
            stepReply = 429 to refusal(limit)
            val again = runCatching { Auth.answerStepAt(live, pressed.answer.token, pressed.answer.proof) }.exceptionOrNull()!!
            step = pressed.step.after(model.answerFailed(again, methods), pressed.answer)
            assertEquals(words, AskPhase.Approved, model.phase)
            assertEquals(words, held, step.lost)
            assertEquals(limit, step.notice)
            assertEquals("Try again", step.button(busy = false, ask = model.phase))
            // Now the step answers, and refuses it: the approval is gone, and only a press would ask the other device afresh.
            val second = (step.pressed(noSheet) as SignInStep.Pressed.Send)
            assertEquals(words, held, second.answer)
            stepReply = 401 to refusal("That didn’t work. Ask your other device again.", "step-wrong")
            val refused = runCatching { Auth.answerStepAt(live, second.answer.token, second.answer.proof) }.exceptionOrNull()!!
            step = second.step.after(model.answerFailed(refused, methods), second.answer)
            assertTrue(words, model.idle)
            assertNull(words, model.approved)
            assertNull(words, model.answer)
            assertNull(words, step.lost)
            assertEquals("That didn’t work. Ask your other device again.", step.fieldError)
            assertEquals("Use another device", step.button(busy = false, ask = model.phase))
            assertTrue(words, step.pressable(busy = false, ask = model.phase))
            // One request to the other device through all of it, and every answer the step's route was sent carried its id.
            delay(30)
            assertEquals(words, 1, made(server))
            assertTrue(words, stepBodies.size >= 2)
            for (body in stepBodies) {
                assertEquals(words, "device", body.getJSONObject("proof").getString("kind"))
                assertEquals(words, server.requestId, body.getJSONObject("proof").getString("requestId"))
                assertEquals(words, ApprovalServer.TOKEN, body.getString("token"))
            }
        }
    }

    @Test
    fun aRefusalTheStepGaveEndsTheApprovalAndAPendingOneAfterTryAgainWaitsOnTheSameRequest(): Unit = runBlocking {
        // The step refused the approved request outright: nothing is kept, and nothing is offered again.
        val refusedBy = ApprovalServer()
        val model = DeviceAskModel(this, { "Pixel 9" }, every = 5)
        val outcomes = mutableListOf<StepOutcome?>()
        model.begin(request(refusedBy), approved = { throw StepRefused(StepRefusal.WRONG, "That didn’t work.", 401) }, failed = { outcomes += model.answerFailed(it, methods) })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        refusedBy.open()
        refusedBy.set("approved")
        waitFor("the refusal") { outcomes.isNotEmpty() }
        assertEquals(StepOutcome.Again("That didn’t work.", true, methods), outcomes.single())
        assertTrue(model.idle)
        assertNull(model.approved)
        assertNull(SignInStep(challenge).after(outcomes.single(), model.approved).lost)
        // Kept after no reply; the same answer sent again finds the approval not landed yet (`step-pending`): nothing is
        // said, nothing is asked of the other device, and the same request answers by itself once more.
        val server = ApprovalServer()
        val answers = mutableListOf<StepAnswer>()
        outcomes.clear()
        model.begin(request(server), failed = { outcomes += model.answerFailed(it, methods) }, approved = { answer ->
            answers += answer
            if (answers.size == 1) throw AuthUnreachable()
        })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        server.open()
        server.set("approved")
        waitFor("no reply") { outcomes.isNotEmpty() }
        assertEquals(StepOutcome.Retry(Problems.OFFLINE), outcomes.single())
        val pending = model.answerFailed(StepRefused(StepRefusal.PENDING, "Waiting for your other device.", 409), methods)
        assertEquals(StepOutcome.Again("", false, methods), pending)
        assertEquals(AskPhase.Approved, model.phase)
        waitFor("the same answer again") { answers.size == 2 }
        assertEquals(answers[0], answers[1])
        assertEquals(StepAnswer(ApprovalServer.TOKEN, StepProof.Device(server.requestId)), answers[1])
        assertEquals(1, made(server))
        model.stop()
    }

    // Answering.

    private class Sheet(val answer: ApprovalAnswer, val closes: MutableList<Pair<String, Boolean>>, val shown: MutableList<String>)

    private fun answering(server: ApprovalServer, scope: CoroutineScope, wire: ApprovalWire = server.wire()): Sheet {
        val prompt = DeviceApprovals.listed(wire).single()
        val closes = mutableListOf<Pair<String, Boolean>>()
        val shown = mutableListOf<String>()
        val flow = ApprovalAnswering(prompt, wire, ApprovalServer.ACCOUNT, deviceSigningCreate().seed)
        return Sheet(
            ApprovalAnswer(flow, scope, closed = { said, important -> closes += said to important }, sessionEnded = { fail("signed out") }, every = 5, codeShown = { shown += flow.id }),
            closes, shown,
        )
    }

    /* The other device reveals, as the server records it, and the code both sides then hold. */
    private fun reveal(server: ApprovalServer, asked: Pair<String, String>): String {
        server.reveal = asked
        server.state = "revealed"
        return deviceStepCode(com.hushos.core.DeviceStep(ApprovalServer.ACCOUNT, server.requestId, server.purpose, server.tokenDigest!!, asked.first), server.approverKey!!, asked.second)
    }

    @Test
    fun aWrongCodeClosesSayingNothingWasApprovedAndTheRightOneIsApprovedOnce(): Unit = runBlocking {
        val server = ApprovalServer()
        val asked = server.asked()
        val sheet = answering(server, this)
        // The field is not there until the other device revealed what it committed to.
        sheet.answer.typing()
        assertEquals(ApprovalAnswer.Phase.WAITING, sheet.answer.phase)
        waitFor("the open") { server.state == "opened" }
        delay(20)
        assertEquals(ApprovalAnswer.Phase.WAITING, sheet.answer.phase)
        val code = reveal(server, asked)
        waitFor("the field") { sheet.answer.phase == ApprovalAnswer.Phase.TYPING }
        // Completion: words the beginning could become, and none once it is one of them.
        sheet.answer.type("12 riv")
        assertEquals(listOf("rival", "river"), sheet.answer.completions)
        sheet.answer.complete("river")
        assertEquals("12 river", sheet.answer.typed)
        assertTrue(sheet.answer.completions.isEmpty())
        // Not the code: ended as a wrong code, once, nothing signed, and the sheet closes saying so until it is read.
        sheet.answer.type(if (code == "12 river") "13 river" else "12 river")
        sheet.answer.approve()
        sheet.answer.approve()
        waitFor("the close") { sheet.closes.isNotEmpty() }
        assertEquals(listOf("That code didn’t match, so nothing was approved." to true), sheet.closes)
        assertEquals("wrong-code", server.deniedFor)
        assertEquals(1, server.calls("/deny").size)
        assertNull(server.signature)

        // The code itself: signed and approved, once however often Approve is pressed, with the brief confirmation.
        val second = ApprovalServer()
        val made = second.asked()
        val right = answering(second, this)
        right.answer.typing()
        waitFor("the open") { second.state == "opened" }
        val shown = reveal(second, made)
        waitFor("the field") { right.answer.phase == ApprovalAnswer.Phase.TYPING }
        right.answer.type(shown.uppercase())
        right.answer.approve()
        right.answer.approve()
        waitFor("the close") { right.closes.isNotEmpty() }
        assertEquals(listOf("Approved" to false), right.closes)
        assertEquals(1, second.calls("/approve").size)
        assertNotNull(second.signature)
        assertNull(second.deniedFor)
    }

    @Test
    fun denyOverAWaitEndsTheRequestOnceAndNothingWaitsOnBehindIt(): Unit = runBlocking {
        val server = ApprovalServer()
        server.asked()
        val sheet = answering(server, this)
        sheet.answer.typing()
        waitFor("the open") { server.state == "opened" }
        sheet.answer.end(ApprovalAnswering.Ending.NOT_ME)
        sheet.answer.end(ApprovalAnswering.Ending.DENIED)
        waitFor("the close") { sheet.closes.isNotEmpty() }
        assertEquals(listOf("Denied" to false), sheet.closes)
        assertEquals("not-me", server.deniedFor)
        assertEquals(1, server.calls("/deny").size)
        // The wait for the reveal went with it: the list is not asked again, and no field ever appears.
        delay(30)
        val looks = server.calls.size
        delay(60)
        assertEquals(looks, server.calls.size)
        assertEquals(ApprovalAnswer.Phase.WAITING, sheet.answer.phase)
    }

    @Test
    fun anotherCodeInViewIsPassedOverThisRequestsOwnAsksOnlyForApprovalAndAnotherRequestsEndsIt(): Unit = runBlocking {
        val server = ApprovalServer()
        val asked = server.asked()
        val sheet = answering(server, this)
        // Nothing is scanned before the camera was asked for.
        sheet.answer.scanned(approvalQr(server.requestId, server.commitment!!))
        delay(20)
        assertTrue(server.calls("/open").isEmpty())
        sheet.answer.scan()
        // A code that is not an approval's: passed over, with nothing sent and the camera still looking.
        sheet.answer.scanned("https://example.org/not-this")
        delay(20)
        assertEquals(ApprovalAnswer.Phase.SCANNING, sheet.answer.phase)
        assertTrue(server.calls("/open").isEmpty() && server.calls("/deny").isEmpty())
        // This request's own: opened, and once the other device revealed, only Approve is asked. No code is typed.
        sheet.answer.scanned(approvalQr(server.requestId, server.commitment!!))
        waitFor("the open") { server.state == "opened" }
        reveal(server, asked)
        waitFor("the confirmation") { sheet.answer.phase == ApprovalAnswer.Phase.CONFIRM }
        sheet.answer.approve()
        waitFor("the close") { sheet.closes.isNotEmpty() }
        assertEquals(listOf("Approved" to false), sheet.closes)
        assertNotNull(server.signature)

        // The code of another request: this one is ended as a mismatch, unopened, and the sheet closes saying so.
        val other = ApprovalServer()
        other.asked()
        val wrong = answering(other, this)
        wrong.answer.scan()
        wrong.answer.scanned(approvalQr("00000000-0000-4000-8000-000000000001", other.commitment!!))
        waitFor("the close") { wrong.closes.isNotEmpty() }
        assertEquals(listOf("The other device didn’t match its request, so nothing was approved." to true), wrong.closes)
        assertEquals("mismatch", other.deniedFor)
        assertTrue(other.calls("/open").isEmpty())
        assertNull(other.signature)
    }

    @Test
    fun waitingForTheOtherDeviceAfterAScanHoldsNothingUpAndDenyEndsTheRequest(): Unit = runBlocking {
        val server = ApprovalServer()
        server.asked()
        val sheet = answering(server, this)
        sheet.answer.scan()
        sheet.answer.scanned(approvalQr(server.requestId, server.commitment!!))
        waitFor("the open") { server.state == "opened" }
        waitFor("the wait") { sheet.answer.phase == ApprovalAnswer.Phase.WAITING }
        // Opened, and the other device has revealed nothing yet. That can last minutes: the sheet is not busy, so it
        // can be closed, and Deny and This wasn’t me are within reach.
        waitFor("the sheet let go") { !sheet.answer.busy }
        delay(20)
        assertFalse(sheet.answer.busy)
        assertEquals(ApprovalAnswer.Phase.WAITING, sheet.answer.phase)
        sheet.answer.end(ApprovalAnswering.Ending.DENIED)
        waitFor("the close") { sheet.closes.isNotEmpty() }
        assertEquals(listOf("Denied" to false), sheet.closes)
        assertEquals("denied", server.deniedFor)
        assertNull(server.signature)
        // The wait went with it: nothing looks for the reveal any more.
        delay(30)
        val looks = server.calls.size
        delay(60)
        assertEquals(looks, server.calls.size)
    }

    @Test
    fun theRequestThatTurnsTheMethodOnIsNeitherScannedNorTypedAndItsCodeStaysUpUntilDone(): Unit = runBlocking {
        val server = ApprovalServer()
        val asked = server.asked(purpose = DeviceEnrolment.PURPOSE)
        val sheet = answering(server, this)
        assertTrue(sheet.answer.turnsOn)
        // No camera and no field for it, whatever is pressed or read: nothing is opened by either road.
        sheet.answer.scan()
        assertEquals(ApprovalAnswer.Phase.CHOOSE, sheet.answer.phase)
        sheet.answer.scanned(approvalQr(server.requestId, server.commitment!!))
        sheet.answer.typing()
        delay(30)
        assertEquals(ApprovalAnswer.Phase.CHOOSE, sheet.answer.phase)
        assertTrue(server.calls("/open").isEmpty())
        // Opened (Answer was the press), and nothing can be approved before the other device revealed.
        sheet.answer.open()
        sheet.answer.open()
        assertEquals(ApprovalAnswer.Phase.WAITING, sheet.answer.phase)
        waitFor("the open") { server.state == "opened" }
        sheet.answer.approve()
        delay(20)
        assertEquals(1, server.calls("/open").size)
        assertTrue(server.calls("/approve").isEmpty())
        // Waiting holds nothing up here either.
        assertFalse(sheet.answer.busy)
        reveal(server, asked)
        waitFor("Approve") { sheet.answer.phase == ApprovalAnswer.Phase.CONFIRM }
        assertNull(sheet.answer.code)
        // The press: signed once with nothing typed, and the code is up. Nothing is said, and nothing closes.
        sheet.answer.approve()
        sheet.answer.approve()
        waitFor("the code") { sheet.answer.phase == ApprovalAnswer.Phase.SHOWING }
        // The code on the sheet is the one this phone drew: its digest is what the server was given, and nothing else of it.
        val code = sheet.answer.code!!
        assertEquals(server.codeDigest, turnOnCodeDigest(server.requestId, code))
        assertEquals(1, server.calls("/approve").size)
        assertNotNull(server.signature)
        assertEquals(listOf(server.requestId), sheet.shown)
        // Approved: there is nothing left to deny, and the code stays for as long as the person needs to type it.
        sheet.answer.end(ApprovalAnswering.Ending.NOT_ME)
        sheet.answer.scan()
        delay(60)
        assertTrue(server.calls("/deny").isEmpty())
        assertEquals(ApprovalAnswer.Phase.SHOWING, sheet.answer.phase)
        assertEquals(code, sheet.answer.code)
        assertTrue(sheet.closes.isEmpty())
        // Done closes it, with the brief confirmation.
        sheet.answer.done()
        assertEquals(listOf("Approved" to false), sheet.closes)

        // A sign-in's sheet is not opened by `open`, and Done closes nothing there: it is scanned or typed.
        val signIn = ApprovalServer()
        signIn.asked()
        val other = answering(signIn, this)
        assertFalse(other.answer.turnsOn)
        other.answer.open()
        other.answer.done()
        delay(30)
        assertEquals(ApprovalAnswer.Phase.CHOOSE, other.answer.phase)
        assertTrue(signIn.calls("/open").isEmpty())
        assertTrue(other.closes.isEmpty())
    }

    @Test
    fun anApprovalWhoseReplyWasLostLeavesApproveThereAndTheNextPressShowsTheCodeThatWasSent(): Unit = runBlocking {
        val server = ApprovalServer()
        val asked = server.asked(purpose = DeviceEnrolment.PURPOSE)
        val sheet = answering(server, this)
        sheet.answer.open()
        waitFor("the open") { server.state == "opened" }
        reveal(server, asked)
        waitFor("Approve") { sheet.answer.phase == ApprovalAnswer.Phase.CONFIRM }
        // The server took the approval and its answer never arrived: no code is shown for an approval nothing confirmed,
        // the sheet says so and stays, and Approve is still there.
        server.loseApproveReply = true
        sheet.answer.approve()
        waitFor("the lost reply") { sheet.answer.error.isNotEmpty() }
        assertEquals(StepWords.LOST_CHANGE, sheet.answer.error)
        assertEquals(ApprovalAnswer.Phase.CONFIRM, sheet.answer.phase)
        // Unsettled: the button reads Try again, and the request is not called over.
        assertTrue(sheet.answer.unsure)
        assertNull(sheet.answer.code)
        assertFalse(sheet.answer.busy)
        assertTrue(sheet.closes.isEmpty() && sheet.shown.isEmpty())
        val kept = server.codeDigest
        assertNotNull(kept)
        // The server approved it, so it lists it no longer. The press needs no list: the reveal it checked is its own.
        assertEquals("approved", server.state)
        assertTrue(DeviceApprovals.listed(server.wire()).isEmpty())
        val looks = lists(server)
        // Pressed again: the same approval, and the code now up is the one whose digest the server has had all along.
        sheet.answer.approve()
        waitFor("the code") { sheet.answer.phase == ApprovalAnswer.Phase.SHOWING }
        assertEquals(listOf(kept, kept), server.calls("/approve").map { it.body.getString("codeDigest") })
        assertEquals(kept, turnOnCodeDigest(server.requestId, sheet.answer.code!!))
        assertEquals("", sheet.answer.error)
        assertFalse(sheet.answer.unsure)
        assertEquals(looks, lists(server))
        sheet.answer.done()
        assertEquals(listOf("Approved" to false), sheet.closes)
    }

    /* How often the answering phone's list was read. */
    private fun lists(server: ApprovalServer) = server.calls("/api/auth/approvals").count { it.method == "GET" }

    /* The server as it is, but its answer to the next approval is `lost`'s: what came back in its place, or a throw for nothing at all. */
    private fun losing(server: ApprovalServer, lost: (ApprovalWire.Reply) -> ApprovalWire.Reply): ApprovalWire {
        val real = server.wire()
        val once = java.util.concurrent.atomic.AtomicBoolean(true)
        return ApprovalWire(real.session) { method, path, body, stepToken ->
            val reply = real.send(method, path, body, stepToken)
            if (path.endsWith("/approve") && once.compareAndSet(true, false)) lost(reply) else reply
        }
    }

    @Test
    fun anApprovalTheServerTookIsUnsettledWhateverCameBackInItsAnswersPlaceAndOnlyTheServersRefusalEndsIt(): Unit = runBlocking {
        // The server took each of these approvals. What came back: nothing at all; a server error in the server's own
        // format, which says nothing of what happened to the request; a gateway's page with a 200.
        val losses = listOf<Pair<String, (ApprovalWire.Reply) -> ApprovalWire.Reply>>(
            Problems.OFFLINE to { _ -> throw java.io.IOException("Connection reset") },
            StepWords.LOST_CHANGE to { _ -> ApprovalWire.Reply(500, """{"message":"Something went wrong on HushOS."}""") },
            StepWords.LOST_CHANGE to { _ -> ApprovalWire.Reply(200, "<html>Sign in to the network</html>") },
        )
        for ((said, lost) in losses) {
            val server = ApprovalServer()
            val asked = server.asked(purpose = DeviceEnrolment.PURPOSE)
            val sheet = answering(server, this, losing(server, lost))
            sheet.answer.open()
            waitFor("the open") { server.state == "opened" }
            reveal(server, asked)
            waitFor("Approve") { sheet.answer.phase == ApprovalAnswer.Phase.CONFIRM }
            assertFalse(sheet.answer.unsure)
            sheet.answer.approve()
            waitFor("the missing answer: $said") { sheet.answer.error.isNotEmpty() }
            assertEquals(said, sheet.answer.error)
            assertEquals("approved", server.state)
            // Still this request's sheet, with the press offered again: not closed, nothing said, no code shown unconfirmed.
            assertTrue(said, sheet.answer.unsure)
            assertEquals(ApprovalAnswer.Phase.CONFIRM, sheet.answer.phase)
            assertNull(sheet.answer.code)
            assertTrue(said, sheet.closes.isEmpty() && sheet.shown.isEmpty())
            val kept = server.codeDigest!!
            sheet.answer.approve()
            waitFor("the code: $said") { sheet.answer.phase == ApprovalAnswer.Phase.SHOWING }
            assertEquals(listOf(kept, kept), server.calls("/approve").map { it.body.getString("codeDigest") })
            assertEquals(kept, turnOnCodeDigest(server.requestId, sheet.answer.code!!))
            assertFalse(sheet.answer.unsure)
            assertTrue(sheet.closes.isEmpty())
        }

        // Nothing came back, and the request was over by the next press: the server's refusal is an answer. The
        // sheet closes with its words, and no code is ever shown for it.
        val over = ApprovalServer()
        val asked = over.asked(purpose = DeviceEnrolment.PURPOSE)
        val sheet = answering(over, this, losing(over) { _ -> throw java.io.IOException("Connection reset") })
        sheet.answer.open()
        waitFor("the open") { over.state == "opened" }
        reveal(over, asked)
        waitFor("Approve") { sheet.answer.phase == ApprovalAnswer.Phase.CONFIRM }
        sheet.answer.approve()
        waitFor("the missing answer") { sheet.answer.error.isNotEmpty() }
        assertTrue(sheet.answer.unsure)
        over.set("ended", "expired")
        sheet.answer.approve()
        waitFor("the refusal") { sheet.closes.isNotEmpty() }
        assertEquals(listOf("This request is over." to true), sheet.closes)
        assertFalse(sheet.answer.unsure)
        assertNull(sheet.answer.code)
        assertTrue(sheet.shown.isEmpty())

        // A sign-in's request has no code to owe: a lost approval there is said, and Approve stays Approve.
        val signIn = ApprovalServer()
        val made = signIn.asked()
        val other = answering(signIn, this)
        other.answer.typing()
        waitFor("the open") { signIn.state == "opened" }
        val code = reveal(signIn, made)
        waitFor("the field") { other.answer.phase == ApprovalAnswer.Phase.TYPING }
        other.answer.type(code)
        signIn.loseApproveReply = true
        other.answer.approve()
        waitFor("the lost reply") { other.answer.error.isNotEmpty() }
        assertEquals(StepWords.LOST_CHANGE, other.answer.error)
        assertFalse(other.answer.unsure)
    }
}
