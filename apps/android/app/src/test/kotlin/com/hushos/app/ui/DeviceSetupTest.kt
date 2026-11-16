package com.hushos.app.ui

import com.hushos.app.data.ApprovalAnswering
import com.hushos.app.data.ApprovalServer
import com.hushos.app.data.AskPhase
import com.hushos.app.data.DeviceApprovals
import com.hushos.app.data.DeviceEnrolment
import com.hushos.app.data.LostReply
import com.hushos.app.data.Problems
import com.hushos.app.data.StepPurpose
import com.hushos.app.data.StepRefused
import com.hushos.app.data.StepUp
import com.hushos.app.data.StepWords
import com.hushos.app.data.TwoStep
import com.hushos.app.data.TwoStepFlow
import com.hushos.app.data.TwoStepStatus
import com.hushos.app.data.uptime
import com.hushos.core.DeviceStep
import com.hushos.core.StepRefusal
import com.hushos.core.deviceConfirmJson
import com.hushos.core.deviceSigningCreate
import com.hushos.core.deviceStepCode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * Turning on Approve on another device, as Account › Two-step sign-in runs it (`DeviceSetupModel`,
 * docs/two-step-design.md 12, "Turning it on first"). What these hold:
 *
 * - nothing is sent without a device chosen to approve, none is ever chosen for the person, and
 *   every request, the first and each Ask again, names that device and no other;
 * - the page shows no code and no QR code, and the approval alone confirms nothing: the code the
 *   chosen device draws and shows is typed here and sent as it is written, with nothing checked
 *   on this phone (a wrong one is sent too); one the server refuses drops that request only, in
 *   the server's words, and Ask again asks the same device with the same token;
 * - a setup another session is already running is refused on the first step, in the server's words;
 * - the flow is pending from before the confirmation goes out, the page cannot be left meanwhile,
 *   and the backup codes it made are kept whatever happens to the page or the request, until Done;
 * - a confirmation whose reply was lost says it can't tell, once, and the settings are read again;
 * - the other devices are removed only behind the codes, only when this turned the step on with
 *   the box ticked, and never the device that approved.
 *
 * The other device's side is the in-memory server `DeviceApprovalTest` uses, and where the code
 * matters a phone of its own answering over it (`ApprovalAnswering`); the view model's own requests
 * (the pending method, the confirmation, the removal) are handed in, the confirmation either held
 * for the test to answer or sent to that server (`served`).
 */
class DeviceSetupTest {
    @org.junit.Before
    fun clock() { uptime = { 50_000L } }

    private suspend fun waitFor(what: String, met: () -> Boolean) {
        repeat(600) { if (met()) return; delay(5) }
        fail("Never happened: $what")
    }

    private val laptop = TwoStepStatus.Approver("7c9e6679-7425-40de-944b-e07fc1f90ae7", "web", "Maya’s Laptop", "2026-11-02T09:30:00.000Z")
    private val tablet = TwoStepStatus.Approver("40206e32-e631-4237-8b49-066d096eb7ed", "ios", null, "2026-10-20T18:00:00.000Z")
    private val pending = DeviceEnrolment("5b2c0f0e-6f0a-4d0c-9a57-2f1a3a8f6f10", ApprovalServer.TOKEN)
    private val codes = listOf("7KQ2M-9XD4P", "AAAAA-BBBBB")

    /* A code that is one, and nobody's in particular: this phone cannot tell, and sends whatever is typed. */
    private val typed = "47 river"

    /*
     * The view model's part, in the test's hands: the flow it keeps, its session count, and what its requests answered.
     * `served`: a confirmation goes to the in-memory server, which holds it to the digest the approving device posted;
     * otherwise it waits for the test's own answer.
     */
    private inner class Page(scope: CoroutineScope, served: Boolean = false) {
        val server = ApprovalServer().apply { purpose = DeviceEnrolment.PURPOSE }
        /* This phone's device key, which each request commits to. */
        val key = ApprovalServer.random32()
        /* The chosen device's own key. */
        val chosenKey = deviceSigningCreate()
        var flow = TwoStepFlow()
        var era = 0
        /* The passwords the pending method was asked for with, and what the server answers the next one. */
        val starts = mutableListOf<String>()
        var startAnswers: Result<DeviceEnrolment> = Result.success(pending)
        /* Each confirmation that went out, answered when the test says; and whether the flow was pending as it went. */
        val confirms = mutableListOf<CompletableDeferred<Result<TwoStep.DeviceConfirmed>>>()
        /* What each carried: the request and the code. */
        val confirmed = mutableListOf<Pair<String, String>>()
        val pendingAsItWent = mutableListOf<Boolean>()
        /* Each removal asked for: the password, the device kept, and its answer. */
        val removals = mutableListOf<Triple<String, String, (Boolean) -> Unit>>()
        val ask = DeviceAskModel(scope, { "Pixel 9" }, every = 5)
        val model = DeviceSetupModel(
            scope, ask, { flow }, { flow = it }, { era },
            start = { password, _ -> starts += password; startAnswers },
            request = { token, approver -> DeviceAskModel.Request(server.wire(), token, DeviceEnrolment.PURPOSE, key, approver) },
            confirm = { started, requestId, code ->
                pendingAsItWent += flow.pending
                confirmed += requestId to code
                if (served) runCatching { server.wire().send("POST", server.confirmPath, deviceConfirmJson(started.token, requestId, code), null).let { TwoStep.deviceConfirmed(it.status, it.text) } }
                else CompletableDeferred<Result<TwoStep.DeviceConfirmed>>().also { confirms += it }.await()
            },
            removeOthers = { password, keep, done -> removals += Triple(password, keep, done) },
            sessionEnded = { fail("signed out") },
            every = 5,
        )

        /* The requests made to another device, and which device each named. */
        fun named(): List<String?> = server.calls("/api/auth/approvals").filter { it.method == "POST" }.map { it.body.optString("approverDeviceId").ifEmpty { null } }

        /* The step token each of those requests was made for. */
        fun tokens(): List<String> = server.calls("/api/auth/approvals").filter { it.method == "POST" }.map { it.body.getString("stepToken") }

        fun begin(approver: TwoStepStatus.Approver?, first: Boolean = true, signOutOthers: Boolean = true) =
            model.begin("password here", null, first, approver, signOutOthers) { failure -> fail("$failure"); null }

        /* The code both devices could work out for the request that is out, from what each posted. It is nobody's code any more. */
        fun derived(): String = deviceStepCode(DeviceStep(ApprovalServer.ACCOUNT, server.requestId, DeviceEnrolment.PURPOSE, server.tokenDigest!!, key), server.approverKey!!, server.reveal!!.second)

        /*
         * The chosen device answers the request that is out, as a phone does: it opens it, checks this phone's reveal,
         * and on Approve draws a code, posts its digest signed, and shows the code. Handed back: what its screen shows.
         * The page now asks for it.
         */
        suspend fun answered(): String {
            waitFor("the request") { ask.phase == AskPhase.Asked }
            val wire = server.wire()
            val answering = ApprovalAnswering(DeviceApprovals.listed(wire).single(), wire, ApprovalServer.ACCOUNT, chosenKey.seed)
            answering.open()
            answering.awaitReveal(every = 5)
            val shown = answering.approve(null)!!
            waitFor("the code field") { model.ready }
            return shown
        }

        /* The chosen device opens the request that is out, this phone reveals, and the server says it approved: the page now asks for a code. */
        suspend fun approve() {
            waitFor("the request") { ask.phase == AskPhase.Asked }
            val before = server.reveal
            server.open()
            waitFor("the reveal") { server.reveal != before }
            server.set("approved")
            waitFor("the code field") { model.ready }
        }

        /* Continue, the chosen device approves, and its code is typed here: the confirmation is out, waiting for the test's answer. */
        suspend fun approvedBy(approver: TwoStepStatus.Approver, first: Boolean = true, signOutOthers: Boolean = true) {
            begin(approver, first, signOutOthers)
            approve()
            model.code.type(typed)
            model.turnOn()
            waitFor("the confirmation") { confirms.size == 1 }
        }
    }

    @Test
    fun withNoDeviceChosenNothingIsSentAndTheChosenOneIsNamedTheFirstTimeAndEveryTimeAgain(): Unit = runBlocking {
        val page = Page(this)
        // One device could approve, and the person has not picked it: it is not chosen for them (its name is its own
        // words), and Continue sends nothing, to the server or to any device.
        val one = TwoStepStatus(on = false, methods = emptyList(), backupCodesLeft = 0, totpFrozen = false, otherDevice = true, approvers = listOf(laptop))
        page.begin(one.approver(null))
        delay(40)
        assertTrue(page.starts.isEmpty())
        assertTrue(page.server.calls.isEmpty())
        assertEquals(TwoStepFlow(), page.flow)
        // Nor with two to choose from and neither picked.
        val two = TwoStepStatus(on = false, methods = emptyList(), backupCodesLeft = 0, totpFrozen = false, otherDevice = true, approvers = listOf(laptop, tablet))
        page.begin(two.approver(null))
        delay(40)
        assertTrue(page.starts.isEmpty())
        assertTrue(page.server.calls.isEmpty())
        assertEquals(TwoStepFlow(), page.flow)
        // Picked: the pending method is made, and the request names that device.
        page.begin(two.approver(tablet.id))
        assertTrue(page.flow.pending)
        waitFor("the request") { page.ask.phase == AskPhase.Asked }
        assertEquals(listOf("password here"), page.starts)
        assertEquals(tablet, page.flow.approver)
        assertEquals(listOf<String?>(tablet.id), page.named())
        // While it is out a second press asks nothing more.
        page.model.askAgain()
        delay(20)
        assertEquals(1, page.named().size)
        // It ended without an approval: Ask again names the same device, and makes no second pending method.
        page.server.set("ended", "refused")
        waitFor("the end") { page.ask.phase is AskPhase.Ended }
        page.model.askAgain()
        waitFor("the request again") { page.ask.phase == AskPhase.Asked }
        assertEquals(listOf<String?>(tablet.id, tablet.id), page.named())
        assertEquals(1, page.starts.size)
        assertTrue(page.confirms.isEmpty())
        // Leaving the page lets the request go; nothing was out that could make codes.
        assertTrue(page.model.left())
        assertTrue(page.ask.idle)
    }

    @Test
    fun aRequestTheServerRefusesGoesBackToThePasswordInTheServersWords(): Unit = runBlocking {
        val page = Page(this)
        page.server.refusesStart = 409 to """{"message":"Choose which of your devices will approve.","code":"device-choice"}"""
        page.begin(laptop)
        waitFor("the refusal") { page.flow.error != null }
        assertEquals("Choose which of your devices will approve.", page.flow.error)
        assertNull(page.flow.device)
        assertNull(page.flow.approver)
        assertFalse(page.flow.pending)
        assertTrue(page.ask.idle)
        // The setup went with it: there is nothing to ask again with.
        page.model.askAgain()
        delay(20)
        assertEquals(1, page.named().size)
    }

    @Test
    fun aSetupAnotherSessionIsRunningIsRefusedInTheServersWordsAndThePageStaysOnItsFirstStep(): Unit = runBlocking {
        val page = Page(this)
        val words = "Another of your devices is turning this on. Try again in a few minutes."
        page.startAnswers = Result.failure(StepRefused(StepRefusal.DEVICE_BUSY, words, 409))
        // What the page does with a failure, as its own holder does (`StepUpHolder.failed`): a refusal the step's fields
        // would say themselves comes back as no words for the form. With no step on the account those fields are not drawn.
        var step = StepUp(StepPurpose.TWO_STEP)
        val before = page.flow.reread
        page.model.begin("password here", null, first = true, approver = laptop, signOutOthers = true) { failure ->
            val (next, updated) = step.failed(failure)
            step = updated
            if (next == StepUp.Next.NOT_STEP) Problems.say(failure, Problems.SERVER) else null
        }
        waitFor("the refusal") { !page.flow.pending }
        // Said on the page, in the server's words: it is the setup that was refused, not an answer to the step.
        assertEquals(words, page.flow.error)
        assertEquals(StepUp(StepPurpose.TWO_STEP), step)
        // The first step still: no pending method, no device asked, no code field. Nothing changed, so nothing is read again.
        assertNull(page.flow.device)
        assertNull(page.flow.approver)
        assertTrue(page.server.calls.isEmpty())
        assertTrue(page.ask.idle)
        assertFalse(page.model.ready)
        assertEquals(before, page.flow.reread)
        // Tried again once the other setup is over: it starts as any does.
        page.startAnswers = Result.success(pending)
        page.begin(laptop)
        waitFor("the request") { page.ask.phase == AskPhase.Asked }
        assertNull(page.flow.error)
        assertEquals(listOf<String?>(laptop.id), page.named())
        assertTrue(page.model.left())
    }

    /* The code as a person might type it from another screen: other spacing, a hyphen, capitals. */
    private fun loosely(code: String): String = code.split(" ").let { (digits, word) -> "  $digits-${word.replaceFirstChar(Char::uppercase)} " }

    @Test
    fun theCodeGoesAsTypedWithNothingCheckedHereAndOneTheServerRefusesDropsOnlyThatRequest(): Unit = runBlocking {
        val page = Page(this, served = true)
        page.begin(laptop)
        waitFor("the request") { page.ask.phase == AskPhase.Asked }
        // The chosen device opened it, this phone revealed, and that device approved and shows its code. That sends no
        // confirmation and turns nothing on: the page, which never had a code or a QR code to show, asks for that one.
        val shown = page.answered()
        val first = page.server.requestId
        delay(40)
        assertTrue(page.confirmed.isEmpty())
        assertFalse(page.flow.pending)
        assertNull(page.flow.codes)
        assertFalse(page.server.confirmed)
        // Something that is no code changes nothing: the button is not there to press, and the keyboard's Done does the same.
        page.model.code.type(shown.substringAfter(" "))
        assertFalse(page.model.code.isCode)
        page.model.turnOn()
        delay(20)
        assertTrue(page.confirmed.isEmpty())
        assertTrue(page.model.ready)
        // A code, and not that device's. The one both devices could work out is as wrong as any other, and nothing on
        // this phone can tell: it is sent, as it is written, and the server refuses it.
        val wrong = page.derived().takeIf { it != shown } ?: shown.split(" ").let { (digits, word) -> "%02d $word".format((digits.toInt() + 1) % 100) }
        val reread = page.flow.reread
        page.model.code.type(loosely(wrong))
        assertTrue(page.model.code.isCode)
        page.model.turnOn()
        waitFor("the refusal") { page.ask.phase is AskPhase.Ended && !page.flow.pending }
        assertEquals(listOf(first to wrong), page.confirmed)
        assertEquals(listOf(true), page.pendingAsItWent)
        // That request is over, in the server's words, with Ask again; the field is empty.
        assertEquals(AskPhase.Ended("That code didn’t match, so nothing was turned on."), page.ask.phase)
        assertFalse(page.model.ready)
        assertEquals("", page.model.code.typed)
        // Only the request went. The pending method, its token and the chosen device stand; nobody is sent back to the
        // password, nothing is said as lost, and the settings are not read again.
        assertEquals(pending, page.flow.device)
        assertEquals(laptop, page.flow.approver)
        assertNull(page.flow.error)
        assertNull(page.flow.codes)
        assertEquals(reread, page.flow.reread)
        assertFalse(page.server.confirmed)
        // The dropped request takes no code any more, the right one included.
        page.model.code.type(shown)
        page.model.turnOn()
        delay(40)
        assertEquals(1, page.confirmed.size)
        // Ask again: a new request, to the same device, for the same pending method and token. No second password.
        page.model.askAgain()
        assertEquals("", page.model.code.typed)
        val second = page.answered()
        assertNotEquals(first, page.server.requestId)
        assertEquals(listOf<String?>(laptop.id, laptop.id), page.named())
        assertEquals(listOf(ApprovalServer.TOKEN, ApprovalServer.TOKEN), page.tokens())
        assertEquals(1, page.starts.size)
        // Typed as a person types it: the confirmation carries the approved request and the code as it is written,
        // and the server, holding only its digest, turns the method on.
        page.model.code.type(loosely(second))
        page.model.turnOn()
        waitFor("the codes") { page.flow.codes != null }
        assertEquals(page.server.requestId to second, page.confirmed.last())
        assertEquals(2, page.confirmed.size)
        assertEquals(listOf(true, true), page.pendingAsItWent)
        assertTrue(page.server.confirmed)
        assertFalse(page.model.ready)
        assertEquals("", page.model.code.typed)
        // The code went to the server once, in the confirmation, and to no device.
        assertTrue(page.server.calls.filterNot { it.path.endsWith("/confirm") }.none { it.body.toString().contains(second) })
    }

    @Test
    fun aSecondPressWhileTheConfirmationIsOutSendsNothingMore(): Unit = runBlocking {
        val page = Page(this)
        page.approvedBy(laptop)
        assertEquals(listOf(page.server.requestId to typed), page.confirmed)
        page.model.turnOn()
        delay(20)
        assertEquals(1, page.confirms.size)
        page.confirms.single().complete(Result.success(TwoStep.DeviceConfirmed.TurnedOn(codes)))
        waitFor("the codes") { page.flow.codes != null }
        assertFalse(page.model.ready)
        assertEquals("", page.model.code.typed)
    }

    @Test
    fun anyOtherRefusalOfTheConfirmationGoesBackToThePasswordInItsWordsAndTheSettingsAreReadAgain(): Unit = runBlocking {
        val page = Page(this)
        page.approvedBy(laptop)
        val before = page.flow.reread
        page.confirms.single().complete(Result.failure(StepRefused(StepRefusal.OTHER, "That setup timed out. Start again.", 404)))
        waitFor("the answer") { !page.flow.pending }
        assertEquals("That setup timed out. Start again.", page.flow.error)
        assertNull(page.flow.device)
        assertNull(page.flow.codes)
        assertEquals(before + 1, page.flow.reread)
        assertTrue(page.removals.isEmpty())
        // The request it was typed for is used up: nothing of it is left on the page, and another setup asks afresh.
        assertFalse(page.model.ready)
        assertTrue(page.ask.idle)
        page.begin(laptop)
        waitFor("the request again") { page.named().size == 2 }
        assertTrue(page.model.left())
    }

    @Test
    fun theConfirmationIsPendingBeforeItGoesAndItsCodesOutliveThePageAndTheRequest(): Unit = runBlocking {
        val page = Page(this)
        page.approvedBy(laptop)
        // Pending from before the confirmation went out, not from when it answered: Back is held all the while.
        assertEquals(listOf(true), page.pendingAsItWent)
        assertTrue(page.flow.pending)
        // Leaving the page is refused, and lets nothing go: the answer may be the backup codes.
        assertFalse(page.model.left())
        assertEquals(AskPhase.Approved, page.ask.phase)
        assertEquals(page.flow, page.flow.cleared())
        assertTrue(page.removals.isEmpty())
        // Even with the request's own job gone, what the confirmation answers is kept.
        page.ask.stop()
        page.confirms.single().complete(Result.success(TwoStep.DeviceConfirmed.TurnedOn(codes)))
        waitFor("the codes") { page.flow.codes != null }
        assertEquals(codes, page.flow.codes)
        assertFalse(page.flow.pending)
        assertNull(page.flow.device)
        // They are there until Done, whatever page is opened or left meanwhile.
        assertTrue(page.model.left())
        assertEquals(codes, page.flow.cleared().codes)
        // Only now, behind the codes: every other device but the one that approved.
        assertEquals(listOf("password here" to laptop.id), page.removals.map { it.first to it.second })
        assertTrue(page.flow.removing)
        // A removal that failed is said, and never costs the codes.
        page.removals.single().third(false)
        assertEquals(codes, page.flow.codes)
        assertTrue(page.flow.notRemoved)
        assertFalse(page.flow.removing)
        assertNull(page.flow.seen().codes)
    }

    @Test
    fun aConfirmationWhoseReplyWasLostSaysItCantTellOnceAndTheSettingsAreReadAgain(): Unit = runBlocking {
        val page = Page(this)
        page.approvedBy(laptop)
        val before = page.flow.reread
        page.confirms.single().complete(Result.failure(LostReply(StepWords.LOST_DEVICE_ON)))
        waitFor("the answer") { !page.flow.pending }
        assertEquals("The server’s answer didn’t arrive, so HushOS can’t tell whether approving on another device was turned on. Check before you try again.", page.flow.error)
        assertNull(page.flow.device)
        assertNull(page.flow.codes)
        waitFor("the request let go") { page.ask.idle }
        // Read again once: the request hearing of the same failure does not count it twice.
        assertEquals(before + 1, page.flow.reread)
        // Nothing says it was turned on: no device is removed on a guess.
        assertTrue(page.removals.isEmpty())
        assertTrue(page.model.left())
    }

    @Test
    fun aPendingConfirmationWaitsOnTheSameApprovalAndOnlyTurningTheStepOnWithTheBoxTickedRemovesDevices(): Unit = runBlocking {
        // The approval had not landed where the confirmation went: nothing failed, and the same request is confirmed again.
        val page = Page(this)
        page.approvedBy(laptop, signOutOthers = false)
        page.confirms[0].complete(Result.failure(StepRefused(StepRefusal.PENDING, "Waiting for your other device.", 409)))
        waitFor("the second confirmation") { page.confirms.size == 2 }
        assertEquals(listOf(true, true), page.pendingAsItWent)
        assertNull(page.flow.error)
        assertNotNull(page.flow.device)
        assertEquals(1, page.named().size)
        page.confirms[1].complete(Result.success(TwoStep.DeviceConfirmed.TurnedOn(codes)))
        waitFor("the codes") { page.flow.codes != null }
        // The box was not ticked: nobody is signed out.
        assertTrue(page.removals.isEmpty())
        assertFalse(page.flow.removing)

        // Added beside another method: no box was shown, and a value left ticked removes nothing.
        val beside = Page(this)
        beside.approvedBy(tablet, first = false, signOutOthers = true)
        beside.confirms.single().complete(Result.success(TwoStep.DeviceConfirmed.Added))
        waitFor("the end") { beside.flow.finished != null }
        assertEquals("Approve on another device is on", beside.flow.finished)
        assertTrue(beside.removals.isEmpty())
    }

    @Test
    fun whatAConfirmationAnswersAfterTheSessionChangedIsDropped(): Unit = runBlocking {
        val page = Page(this)
        page.approvedBy(laptop)
        // A sign-out, or another account signing in: the view model moves on and starts the flow afresh.
        page.era++
        page.flow = TwoStepFlow()
        page.model.end()
        page.confirms.single().complete(Result.success(TwoStep.DeviceConfirmed.TurnedOn(codes)))
        delay(40)
        // One account's backup codes are never drawn for whoever is signed in next, and none of its devices removed.
        assertEquals(TwoStepFlow(), page.flow)
        assertTrue(page.removals.isEmpty())
    }
}
