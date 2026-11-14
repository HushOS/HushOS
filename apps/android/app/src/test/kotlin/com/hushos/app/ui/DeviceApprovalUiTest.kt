package com.hushos.app.ui

import com.hushos.app.data.ApprovalAnswering
import com.hushos.app.data.ApprovalServer
import com.hushos.app.data.AskPhase
import com.hushos.app.data.DeviceApprovals
import com.hushos.app.data.LostReply
import com.hushos.app.data.PromptLimit
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepRefused
import com.hushos.app.data.StepWords
import com.hushos.app.data.uptime
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalQr
import com.hushos.core.deviceSigningCreate
import com.hushos.core.deviceStepCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * What a screen holds while a request to another device is out, and while one is being answered
 * (`DeviceAskModel`, `ApprovalAnswer`): nothing is asked until a press, a request let go is not
 * looked at again or answered with, a pending answer waits on the same request, a second press
 * sends nothing twice, and the sheet closes saying what happened. The requests themselves are
 * `DeviceApprovalTest`'s; the server is the same one, in memory.
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
        // Approved, and the step's answer got no reply: heard as that, with the same answer kept to send again.
        val server = ApprovalServer()
        failures.clear()
        model.begin(request(server), approved = { throw LostReply(StepWords.LOST_STEP) }, failed = { failures += it })
        waitFor("the QR code") { model.phase is AskPhase.Waiting }
        server.open()
        server.set("approved")
        waitFor("the lost reply") { failures.isNotEmpty() }
        assertTrue(failures.single() is LostReply)
        assertTrue(model.idle)
        assertEquals(StepAnswer(ApprovalServer.TOKEN, StepProof.Device(server.requestId)), model.answer)
    }

    // Answering.

    private class Sheet(val answer: ApprovalAnswer, val closes: MutableList<Pair<String, Boolean>>)

    private fun answering(server: ApprovalServer, scope: CoroutineScope): Sheet {
        val wire = server.wire()
        val prompt = DeviceApprovals.list(wire, PromptLimit({ "" }, {})).single()
        val closes = mutableListOf<Pair<String, Boolean>>()
        val flow = ApprovalAnswering(prompt, wire, ApprovalServer.ACCOUNT, deviceSigningCreate().seed)
        return Sheet(ApprovalAnswer(flow, scope, closed = { said, important -> closes += said to important }, sessionEnded = { fail("signed out") }, every = 5), closes)
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
}
