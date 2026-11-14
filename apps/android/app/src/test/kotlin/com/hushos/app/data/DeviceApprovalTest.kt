package com.hushos.app.data

import com.hushos.core.ApprovalEnded
import com.hushos.core.ApprovalPrompt
import com.hushos.core.DeviceStep
import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalQr
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.deviceEmailHash
import com.hushos.core.deviceSigningCreate
import com.hushos.core.deviceSigningPublicKey
import com.hushos.core.deviceStepCode
import com.hushos.core.deviceStepCommitment
import com.hushos.core.deviceStepStatement
import com.hushos.core.deviceStepVerify
import com.hushos.core.randomBytes
import com.hushos.core.stepTokenDigest
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.Collections
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Approve on another device as the second step (docs/two-step-design.md 12). What these hold:
 *
 * - the asking phone posts only its commitment, reveals nothing before another device opened the
 *   request, reveals once, and answers the step only with an approved request (`step-pending`
 *   keeps it waiting and is never an error);
 * - a phone with no device key commits to the very key it then registers with;
 * - the answering phone refuses a reveal that is not the commitment it saw before opening, and a
 *   scanned code for another request or commitment, signs only on the exact code, and ends the
 *   request (`wrong-code`) on anything else;
 * - it shows at most five prompts a day for each class, whatever the server lists;
 * - `twoStepMethods` names `device`, the settings ask for it, and the settings' row says what is true.
 *
 * The server here is a small one in memory that does what the real one does with each route, and
 * can be made to lie where a test needs a server that lies. The twin of the iPhone app's
 * `DeviceApprovalTests`.
 */
class DeviceApprovalTest {
    private val token = ApprovalServer.TOKEN
    private val account = ApprovalServer.ACCOUNT

    private fun random32(): String = ApprovalServer.random32()

    /* The clock since boot, which a JVM test has none of. */
    private var now = 50_000L
    @org.junit.Before
    fun clock() { uptime = { now } }

    private fun begin(server: ApprovalServer, key: String = random32(), purpose: String = "login"): DeviceAsk =
        DeviceAsk.start(server.wire(session = null), token, purpose, key, "Pixel 9")

    private fun challenge(methods: List<StepMethod>, token: String = this.token) = StepChallenge(token, methods, "2026-11-14T10:05:00.000Z", null, null, false, false)

    // The phone that asks.

    @Test
    fun onlyTheCommitmentGoesOutUntilAnotherDeviceOpensTheRequestAndThenTheRevealGoesOnce() {
        val server = ApprovalServer()
        val key = random32()
        val ask = begin(server, key)
        // What made the request: the token, the commitment, and what the phone calls itself. Not the key, not the nonce.
        val made = server.calls("/api/auth/approvals").single().body
        assertEquals(setOf("stepToken", "commitment", "kind", "name"), made.keys().asSequence().toSet())
        assertEquals("android", made.getString("kind"))
        assertEquals("Pixel 9", made.getString("name"))
        assertFalse(made.toString().contains(key))
        // The QR code is that commitment and that request, and nothing else.
        assertEquals(approvalQr(server.requestId, made.getString("commitment")), ask.qr)
        // Looked at again and again while nobody has opened it: nothing is revealed.
        repeat(3) { assertEquals(DeviceAsk.State.Waiting, ask.poll()) }
        assertTrue(server.calls("/reveal").isEmpty())
        // The look carries the token as a header, and no session.
        assertEquals(token, server.calls("/${server.requestId}").last().stepToken)
        // Another device opened it: now, and only now, the key and the nonce go, and the code is shown.
        server.open()
        val shown = ask.poll() as DeviceAsk.State.Code
        val reveal = server.calls("/reveal").single().body
        assertEquals(key, reveal.getString("deviceSigningKey"))
        assertEquals(token, reveal.getString("stepToken"))
        // What was revealed is what was committed to (the server checked: it took the reveal), and the code is the one both sides compute.
        assertEquals("revealed", server.state)
        val step = DeviceStep(account, server.requestId, "login", stepTokenDigest(token), key)
        assertEquals(deviceStepCode(step, server.approverKey!!, reveal.getString("nonce")), shown.code)
        // Looked at again: the same code, and no second reveal. Not even when the server goes on saying `opened`.
        server.staysOpened = true
        repeat(3) { assertEquals(shown, ask.poll()) }
        assertEquals(1, server.calls("/reveal").size)
    }

    @Test
    fun aRevealWhoseReplyWasLostIsNotSentAgainOnceTheServerSaysItHasIt() {
        val server = ApprovalServer()
        val ask = begin(server)
        server.open()
        server.loseRevealReply = true
        // The reveal went and nothing came back: nothing says where the request stands.
        assertThrows(Unanswered::class.java) { ask.poll() }
        // The server took it: the next look says `revealed`, the code is shown, and nothing is sent again.
        assertTrue(ask.poll() is DeviceAsk.State.Code)
        assertEquals(1, server.calls("/reveal").size)
    }

    @Test
    fun theStepIsAnsweredOnlyOnceApprovedAndAPendingAnswerKeepsWaitingWithoutAnError(): Unit = runBlocking {
        val server = ApprovalServer()
        val ask = begin(server)
        val states = Collections.synchronizedList(mutableListOf<DeviceAsk.State>())
        val answers = Collections.synchronizedList(mutableListOf<StepAnswer>())
        var looks = 0
        val done = ask.answered(every = 1, shown = { state ->
            states += state
            looks++
            // Nobody answers the step while the request is only waiting, opened or revealed.
            assertTrue(answers.isEmpty() || state == DeviceAsk.State.Approved)
            when (looks) {
                2 -> server.open()
                4 -> server.set("approved")
            }
        }) { answer ->
            answers += answer
            // The first answer arrives where the approval has not landed yet: not counted, not an error, asked again.
            if (answers.size == 1) throw StepRefused(StepRefusal.PENDING, "Waiting for your other device.", 409)
        }
        assertTrue(done)
        assertEquals(2, answers.size)
        // The answer names this request, for this token, and nothing else.
        assertEquals(StepAnswer(token, StepProof.Device(server.requestId)), answers.first())
        assertEquals(StepMethod.DEVICE, answers.first().method)
        assertEquals(JSONObject().put("kind", "device").put("requestId", server.requestId).toString(), answers.first().json().getJSONObject("proof").toString())
        // Before the approval: the QR code's wait, then the code. Never an answer.
        val before = states.takeWhile { it != DeviceAsk.State.Approved }
        assertTrue(before.isNotEmpty() && before.all { it == DeviceAsk.State.Waiting || it is DeviceAsk.State.Code })
        assertEquals(1, server.calls("/reveal").size)
    }

    @Test
    fun aRequestThatEndedAnswersNothingAndSaysWhy(): Unit = runBlocking {
        for ((ended, why, line) in listOf(
            Triple("refused", ApprovalEnded.REFUSED, "Your other device didn’t approve this."),
            Triple("replaced", ApprovalEnded.REPLACED, "Another sign-in replaced this request."),
            Triple("over", ApprovalEnded.OVER, "This request timed out."),
        )) {
            val server = ApprovalServer()
            val ask = begin(server)
            server.set("ended", ended)
            var answered = false
            assertFalse(ended, ask.answered(every = 1) { answered = true })
            assertFalse(ended, answered)
            assertEquals(DeviceAsk.State.Ended(why), ask.poll())
            assertEquals(line, StepWords.ended(why))
        }
        // A request nothing was heard of for as long as a step lasts is over, on the clock nobody can set.
        val server = ApprovalServer()
        val ask = begin(server)
        now += PendingSignIn.LIFE_MILLIS + 1
        assertEquals(DeviceAsk.State.Ended(ApprovalEnded.OVER), ask.wait(every = 1))
        // A wrong answer from the step's own route while it waits is thrown on, never swallowed as "pending".
        val refused = ApprovalServer()
        val other = begin(refused)
        refused.set("approved")
        refused.approverKey = random32()
        val thrown = runCatching { other.answered(every = 1) { throw StepRefused(StepRefusal.EXPIRED, "This sign-in timed out.", 401) } }.exceptionOrNull()
        assertEquals(StepRefusal.EXPIRED, (thrown as StepRefused).refusal)
    }

    @Test
    fun aRefusalToAskIsTheServersOwnWordsAndWithdrawsOnlyTheOtherDevice() {
        val all = listOf(StepMethod.DEVICE, StepMethod.WEBAUTHN, StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE)
        for ((status, code, refusal) in listOf(
            Triple(409, "device-unavailable", StepRefusal.DEVICE_UNAVAILABLE), Triple(409, "device-busy", StepRefusal.DEVICE_BUSY), Triple(429, "device-limited", StepRefusal.DEVICE_LIMITED),
        )) {
            val server = ApprovalServer()
            server.refusesStart = status to JSONObject().put("message", "No other device can approve this right now.").put("code", code).toString()
            val thrown = assertThrows(StepRefused::class.java) { begin(server) }
            assertEquals(refusal, thrown.refusal)
            // At a sign-in: the server's sentence above the fields, and every other way still there.
            val outcome = StepOutcome.after(thrown, all, tried = StepMethod.DEVICE) as StepOutcome.Again
            assertEquals("No other device can approve this right now.", outcome.message)
            assertFalse(outcome.field)
            assertEquals(all - StepMethod.DEVICE, outcome.methods)
            // Inside a change: the same, beside the step.
            val (next, step) = StepUp(StepPurpose.PASSWORD).take(challenge(all)).failed(thrown)
            assertEquals(StepUp.Next.AGAIN, next)
            assertEquals(all - StepMethod.DEVICE, step.methods)
            assertEquals("No other device can approve this right now.", step.error)
        }
        // A step that is over when the request is made goes back to the password, as from any other route.
        val over = ApprovalServer()
        over.refusesStart = 401 to """{"message":"This sign-in timed out.","code":"step-expired"}"""
        assertTrue(StepOutcome.after(assertThrows(StepRefused::class.java) { begin(over) }, all, tried = StepMethod.DEVICE) is StepOutcome.Over)
        // A gateway's page is nobody's answer: nothing is concluded, and every way stays.
        val lost = ApprovalServer()
        lost.refusesStart = 502 to "<html>Bad gateway</html>"
        assertEquals(all, (StepOutcome.after(assertThrows(Unanswered::class.java) { begin(lost) }, all, tried = StepMethod.DEVICE) as StepOutcome.Again).methods)
    }

    @Test
    fun aPendingAnswerIsNeverAWrongAnswerOnTheScreenOrInAForm() {
        val all = listOf(StepMethod.DEVICE, StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE)
        val pending = StepRefused(StepRefusal.PENDING, "Waiting for your other device.", 409)
        // At a sign-in: nothing is said, nothing is taken away, and it is not the field's complaint.
        val outcome = StepOutcome.after(pending, all, tried = StepMethod.DEVICE) as StepOutcome.Again
        assertEquals("", outcome.message)
        assertFalse(outcome.field)
        assertEquals(all, outcome.methods)
        val shown = SignInStep(challenge(all)).after(outcome, StepAnswer(token, StepProof.Device("r")))
        assertEquals("", shown.notice)
        assertEquals("", shown.fieldError)
        assertNull(shown.lost)
        // In a form: the step stays, says nothing, and the approval it carried is no longer its answer.
        val approved = StepUp(StepPurpose.DELETE).take(challenge(all)).approved(ApprovedRequest(token, "r"))
        assertTrue(approved.deviceApproved)
        val (next, step) = approved.failed(pending)
        assertEquals(StepUp.Next.AGAIN, next)
        assertEquals("", step.error)
        assertEquals(all, step.methods)
        assertFalse(step.deviceApproved)
        // A request that ended under the change (denied, over, taken) says so in the server's words, and can be asked again.
        for (refusal in listOf(StepRefusal.APPROVAL_OVER, StepRefusal.APPROVAL_TAKEN, StepRefusal.APPROVAL_REFUSED, StepRefusal.DEVICE_MISMATCH)) {
            val (after, ended) = approved.failed(StepRefused(refusal, "This request is over.", 409))
            assertEquals(StepUp.Next.AGAIN, after)
            assertEquals("This request is over.", ended.error)
            assertFalse(ended.deviceApproved)
            assertEquals(all, ended.methods)
            assertEquals(all, (StepOutcome.after(StepRefused(refusal, "This request is over.", 409), all, tried = StepMethod.DEVICE) as StepOutcome.Again).methods)
        }
    }

    @Test
    fun aChangeCarriesOnlyARequestApprovedForItsOwnStep(): Unit = runBlocking {
        val sheet = object : KeySheet {
            override suspend fun assertion(request: com.hushos.core.StepKeyRequest): com.hushos.core.KeyAssertion? = null
            override suspend fun registration(creation: com.hushos.core.KeyCreation): com.hushos.core.KeyRegistration? = null
        }
        val all = listOf(StepMethod.DEVICE, StepMethod.TOTP)
        val step = StepUp(StepPurpose.PASSWORD).take(challenge(all))
        // Nothing approved yet: there is nothing to carry.
        assertTrue(step.prove(sheet) is StepUp.Proof.Unready)
        // An approval for another step's token is not taken.
        assertFalse(step.approved(ApprovedRequest("another-token", "r")).deviceApproved)
        // This step's: the change carries the request, by its id.
        val approved = step.approved(ApprovedRequest(token, "7c9e6679-7425-40de-944b-e07fc1f90ae7"))
        val ready = approved.prove(sheet) as StepUp.Proof.Ready
        assertEquals(StepAnswer(token, StepProof.Device("7c9e6679-7425-40de-944b-e07fc1f90ae7")), ready.answer)
        // A new step (the old one ran out) keeps what was typed and drops the approval: it was for the token before.
        val typed = approved.typed(approved.draft.copy(totp = "123456"))
        val renewed = typed.take(challenge(all, token = "u".repeat(43)), keep = true)
        assertFalse(renewed.deviceApproved)
        assertEquals("123456", renewed.draft.totp)
        assertTrue(renewed.prove(sheet) is StepUp.Proof.Unready)
        // And the draft itself never answers another token with it.
        assertThrows(AuthFailure::class.java) { approved.draft.answer(challenge(all, token = "u".repeat(43)), StepMethod.DEVICE) }
    }

    @Test
    fun anotherDeviceIsOfferedOnlyToAPhoneWithAKeyToAskItWith() {
        val first = challenge(listOf(StepMethod.DEVICE, StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE))
        assertEquals(first, first.offered(passkeys = false, device = true))
        val without = first.offered(passkeys = false, device = false)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), without.methods)
        // It was the usual way, and it is not on offer here: the step says so, and never why.
        assertEquals(StepNote.USUAL_SIGN_IN, StepNote.of(without, passkeys = false, change = false))
        // Left out from further down, nothing is said.
        val later = challenge(listOf(StepMethod.TOTP, StepMethod.DEVICE, StepMethod.BACKUP)).offered(passkeys = false, device = false)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP), later.methods)
        assertEquals("", StepNote.of(later, passkeys = false, change = false))
        // The screen opens on it when the server put it first, and its one button asks, waits, and asks again.
        val step = SignInStep(first)
        assertEquals(StepMethod.DEVICE, step.shown)
        assertEquals("Use another device", step.button(busy = false))
        assertTrue(step.pressable(busy = false))
        for (out in listOf(AskPhase.Starting, AskPhase.Waiting("qr"), AskPhase.Code("47 river"))) {
            assertEquals("Waiting for your other device", step.button(busy = false, ask = out))
            assertFalse(step.pressable(busy = false, ask = out))
        }
        assertEquals("Ask again", step.button(busy = false, ask = AskPhase.Ended(StepWords.ASK_REFUSED)))
        assertTrue(step.pressable(busy = false, ask = AskPhase.Ended(StepWords.ASK_REFUSED)))
        // A lost reply to its answer offers the same answer again, as for any other way.
        val lost = step.after(StepOutcome.Retry(StepWords.LOST_STEP), StepAnswer(token, StepProof.Device("r")))
        assertEquals("Try again", lost.button(busy = false))
        assertTrue(lost.pressable(busy = false))
        // The press that asks says nothing of the last answer.
        assertEquals(step, lost.asking().copy(notice = ""))
    }

    @Test
    fun aPhoneWithNoDeviceKeyCommitsToTheKeyItThenRegistersWith() {
        // No key was proved at sign-in: one is made now, before there is a session, and the step keeps it.
        val listed = challenge(listOf(StepMethod.DEVICE, StepMethod.TOTP))
        val pending = Auth.pending("https://step.test", "maya@example.org", listed, ByteArray(64), passkeys = false, proved = null)
        val asking = pending.deviceKey!!
        val made = asking.made!!
        assertEquals(base64urlEncode(made.publicKey), asking.publicKey)
        assertEquals(listOf(StepMethod.DEVICE, StepMethod.TOTP), pending.challenge.methods)
        val server = ApprovalServer()
        val ask = begin(server, key = asking.publicKey)
        server.open()
        ask.poll()
        val revealed = server.calls("/reveal").single().body.getString("deviceSigningKey")
        // The server took the reveal: it was the commitment's key.
        assertEquals("revealed", server.state)
        // Signed in: the phone describes itself with that very key, and keeps its seed.
        val registered = mutableListOf<String>()
        val stored = mutableListOf<Shared.DeviceIdentity>()
        Auth.registerDevice(SessionDevice("d", false), account, "maya@example.org", pending.deviceKey?.made, { key -> registered += key; "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d" }, { stored += it })
        assertEquals(listOf(revealed), registered)
        val kept = stored.single()
        assertTrue(kept.seed.contentEquals(made.seed))
        assertEquals(revealed, base64urlEncode(deviceSigningPublicKey(kept.seed)))
        assertEquals("5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", kept.deviceId)
        assertEquals(deviceEmailHash("maya@example.org"), kept.emailHash)
        // A key the server would not take is kept nowhere: the next launch registers a fresh one.
        assertThrows(AuthFailure::class.java) {
            Auth.registerDevice(SessionDevice("d", false), account, "maya@example.org", made, { throw AuthFailure("No.", 409) }, { stored += it })
        }
        assertEquals(1, stored.size)
        // A phone the account knows asks with the key it proved, and makes none.
        val own = deviceSigningCreate()
        val identity = Shared.DeviceIdentity(account, deviceEmailHash("maya@example.org"), "d", own.seed)
        val known = Auth.pending("https://step.test", "maya@example.org", listed, ByteArray(64), passkeys = false, proved = identity).deviceKey!!
        assertEquals(base64urlEncode(own.publicKey), known.publicKey)
        assertNull(known.made)
        // A device that already described itself registers nothing.
        Auth.registerDevice(SessionDevice("d", true), account, "maya@example.org", null, { key -> registered += key; "x" }, { stored += it })
        assertEquals(1, registered.size)
        // A step that lists no other device makes no key; and with no key to be had, another device is not offered.
        var asked = 0
        assertNull(Auth.pending("o", "e", challenge(listOf(StepMethod.TOTP)), ByteArray(64), false, null) { asked++; null }.deviceKey)
        assertEquals(0, asked)
        val keyless = Auth.pending("o", "e", listed, ByteArray(64), false, null) { null }
        assertNull(keyless.deviceKey)
        assertEquals(listOf(StepMethod.TOTP), keyless.challenge.methods)
    }

    @Test
    fun thisPhonesOwnKeyIsOnlyEverTheSignedInAccounts() {
        val own = deviceSigningCreate()
        val identity = Shared.DeviceIdentity(account.uppercase(), "h", "d", own.seed)
        val session = Shared.Session("https://step.test", "s", account)
        assertSame(identity, DeviceApprovals.identity(session, identity))
        assertEquals(base64urlEncode(own.publicKey), DeviceApprovals.ownKey(session, identity))
        assertNull(DeviceApprovals.identity(null, identity))
        assertNull(DeviceApprovals.identity(session, null))
        // Another account signed in on the phone: the key kept for the last one asks and approves nothing.
        val other = Shared.Session("https://step.test", "s", "7c9e6679-7425-40de-944b-e07fc1f90ae7")
        assertNull(DeviceApprovals.identity(other, identity))
        assertNull(DeviceApprovals.ownKey(other, identity))
    }

    // The phone that answers.

    private inner class Phone(server: ApprovalServer, limit: PromptLimit = PromptLimit({ "" }, {})) {
        val key = deviceSigningCreate()
        val wire = server.wire()
        /* The request as this phone first saw it listed, before it opened it. */
        val prompt: ApprovalPrompt = DeviceApprovals.list(wire, limit).single { it.id == server.requestId }
        val flow = ApprovalAnswering(prompt, wire, account, key.seed)
    }

    private fun signedStep(server: ApprovalServer, asked: Pair<String, String>, userId: String = account) =
        DeviceStep(userId, server.requestId, server.purpose, server.tokenDigest!!, asked.first)

    @Test
    fun aRevealThatIsNotTheCommitmentSeenBeforeOpeningEndsTheRequestAndNothingIsSigned() {
        val server = ApprovalServer()
        server.asked()
        val phone = Phone(server)
        phone.flow.open()
        // A server that swaps the request under the phone: another key and nonce, and a commitment listed to match them.
        val swapped = random32() to random32()
        server.listedReveal = swapped
        server.listedCommitment = deviceStepCommitment("login", server.tokenDigest!!, swapped.first, swapped.second)
        assertThrows(ApprovalProblem.Mismatch::class.java) { phone.flow.revealed() }
        // Ended as a mismatch (not a failed step), and nothing was signed. Nor will anything be.
        assertEquals("mismatch", server.deniedFor)
        assertNull(server.signature)
        assertThrows(Unanswered::class.java) { phone.flow.approve(null) }
        assertTrue(server.calls("/approve").isEmpty())
        assertEquals("The other device didn’t match its request, so nothing was approved.", ApprovalProblem.Mismatch().message)
    }

    @Test
    fun aRevealOfAnotherKeyUnderTheSameCommitmentIsRefusedToo() {
        val server = ApprovalServer()
        val asked = server.asked()
        val phone = Phone(server)
        phone.flow.open()
        // The commitment stands as listed; what is "revealed" is another device's key with the honest nonce.
        server.listedReveal = random32() to asked.second
        assertThrows(ApprovalProblem.Mismatch::class.java) { phone.flow.revealed() }
        assertEquals("mismatch", server.deniedFor)
        assertTrue(server.calls("/approve").isEmpty())
    }

    @Test
    fun nothingIsLookedForUntilThisPhoneOpenedTheRequestAndTheRevealIsWaitedFor(): Unit = runBlocking {
        val server = ApprovalServer()
        val asked = server.asked()
        val phone = Phone(server)
        val lists = server.calls("/api/auth/approvals").size
        // Not opened: there is nothing to wait for, and nothing is asked.
        assertFalse(phone.flow.revealed())
        assertEquals(lists, server.calls("/api/auth/approvals").size)
        phone.flow.open()
        // Opened with this phone's own fresh value, once: a second open sends nothing.
        phone.flow.open()
        assertEquals(1, server.calls("/open").size)
        assertEquals(43, server.calls("/open").single().body.getString("ephemeralKey").length)
        // Opened, not yet revealed: looked for, and not there.
        assertFalse(phone.flow.revealed())
        // The asking device reveals: found at the next look.
        server.reveal = asked
        server.state = "revealed"
        phone.flow.awaitReveal(every = 1)
        assertTrue(phone.flow.revealed())
        // A request that left the list while it was waited for is over, in so many words.
        val gone = ApprovalServer()
        gone.asked()
        val other = Phone(gone)
        other.flow.open()
        gone.set("ended")
        val over = runCatching { other.flow.awaitReveal(every = 1) }.exceptionOrNull()
        assertEquals("This request is over.", (over as ApprovalProblem.Over).message)
    }

    @Test
    fun aScannedCodeForAnotherRequestOrAnotherCommitmentEndsThisOneUnopened() {
        // Anything that is not an approval's code is passed over: nothing happens.
        val quiet = ApprovalServer()
        quiet.asked()
        val looking = Phone(quiet)
        assertFalse(looking.flow.openScanned("https://hushos.com"))
        assertFalse(looking.flow.openScanned("hushos-approve:AAAA"))
        assertTrue(quiet.calls("/open").isEmpty() && quiet.calls("/deny").isEmpty())

        // The right commitment under another request's id.
        val server = ApprovalServer()
        server.asked()
        val phone = Phone(server)
        assertThrows(ApprovalProblem.Mismatch::class.java) { phone.flow.openScanned(approvalQr("00000000-0000-4000-8000-000000000001", server.commitment!!)) }
        assertEquals("mismatch", server.deniedFor)
        assertTrue(server.calls("/open").isEmpty())
        assertFalse(phone.flow.scanned)

        // This request's id with another commitment: the screen in front of the camera is not the one the server listed.
        val second = ApprovalServer()
        second.asked()
        val other = Phone(second)
        assertThrows(ApprovalProblem.Mismatch::class.java) { other.flow.openScanned(approvalQr(second.requestId, random32())) }
        assertEquals("mismatch", second.deniedFor)
        assertTrue(second.calls("/open").isEmpty())
        assertTrue(second.calls("/approve").isEmpty())
    }

    @Test
    fun afterAScanOfThisVeryRequestTheApprovalIsSignedWithNothingTyped() {
        val server = ApprovalServer()
        val asked = server.asked(purpose = "password")
        val phone = Phone(server)
        assertTrue(phone.flow.openScanned(" ${approvalQr(server.requestId, server.commitment!!)}\n"))
        assertTrue(phone.flow.scanned)
        server.reveal = asked
        server.state = "revealed"
        assertTrue(phone.flow.revealed())
        phone.flow.approve(null)
        // Signed by this phone's device key, over this phone's own account id (never the one the list reply named).
        val signature = base64urlDecode(server.signature!!)
        assertTrue(deviceStepVerify(phone.key.publicKey, signedStep(server, asked), signature))
        assertFalse(deviceStepVerify(phone.key.publicKey, signedStep(server, asked, userId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"), signature))
        assertNull(server.deniedFor)
        // After a scan, a reveal that is not the scanned commitment is still refused.
        val lying = ApprovalServer()
        lying.asked()
        val fooled = Phone(lying)
        assertTrue(fooled.flow.openScanned(approvalQr(lying.requestId, lying.commitment!!)))
        lying.listedReveal = random32() to random32()
        assertThrows(ApprovalProblem.Mismatch::class.java) { fooled.flow.revealed() }
        assertNull(lying.signature)
    }

    @Test
    fun onlyTheExactCodeIsSignedAndAnythingElseEndsTheRequest() {
        fun ready(): Triple<ApprovalServer, Phone, String> {
            val server = ApprovalServer()
            val asked = server.asked()
            val phone = Phone(server)
            phone.flow.open()
            server.reveal = asked
            server.state = "revealed"
            assertTrue(phone.flow.revealed())
            return Triple(server, phone, deviceStepCode(signedStep(server, asked), server.approverKey!!, asked.second))
        }
        // Another code, a code cut short, nothing at all: `wrong-code`, and nothing signed.
        for (typed in listOf("00 zebra", "", null)) {
            val (server, phone, code) = ready()
            val wrong = typed?.let { if (it == code) "99 zoo" else it }
            assertThrows("$typed", ApprovalProblem.WrongCode::class.java) { phone.flow.approve(wrong) }
            assertEquals("wrong-code", server.deniedFor)
            assertNull(server.signature)
            assertTrue(server.calls("/approve").isEmpty())
        }
        // The right word with the wrong digits, and the right digits with another word.
        run {
            val (server, phone, code) = ready()
            val (digits, word) = code.split(" ")
            val off = "%02d".format((digits.toInt() + 1) % 100)
            assertThrows(ApprovalProblem.WrongCode::class.java) { phone.flow.approve("$off $word") }
            assertEquals("wrong-code", server.deniedFor)
            assertNull(server.signature)
        }
        // The code itself, however it was typed: signed and approved.
        val (server, phone, code) = ready()
        val (digits, word) = code.split(" ")
        phone.flow.approve("  $digits-${word.uppercase()} ")
        assertNull(server.deniedFor)
        assertNotNull(server.signature)
        assertEquals("approved", server.state)
        assertEquals("That code didn’t match, so nothing was approved.", ApprovalProblem.WrongCode().message)
    }

    @Test
    fun denyAndThisWasntMeEndTheRequestWithTheirOwnReasons() {
        for ((ending, reason) in listOf(ApprovalAnswering.Ending.DENIED to "denied", ApprovalAnswering.Ending.NOT_ME to "not-me")) {
            val server = ApprovalServer()
            server.asked()
            val phone = Phone(server)
            phone.flow.end(ending)
            assertEquals(reason, server.deniedFor)
            assertEquals("ended", server.state)
            assertNull(server.signature)
        }
    }

    @Test
    fun aRequestThatIsOverOrTakenSaysSoInTheServersWords() {
        val server = ApprovalServer()
        server.asked()
        val phone = Phone(server)
        server.set("ended")
        val over = assertThrows(ApprovalProblem.Over::class.java) { phone.flow.open() }
        assertEquals("This request is over.", over.message)
        // An ended session is said as one, never as a request that is over.
        val ended = ApprovalWire(Shared.Session("http://step.test", "s", account)) { _, _, _, _ -> ApprovalWire.Reply(401, """{"message":"Sign in again."}""") }
        assertThrows(NotAuthenticated::class.java) { ApprovalAnswering(phone.prompt, ended, account, phone.key.seed).open() }
        assertThrows(NotAuthenticated::class.java) { DeviceApprovals.listed(ended) }
        // A reply that is not the server's answer to an approval claims nothing.
        val lost = ApprovalWire(Shared.Session("http://step.test", "s", account)) { _, _, _, _ -> ApprovalWire.Reply(200, "{}") }
        assertThrows(Unanswered::class.java) { ApprovalAnswering(phone.prompt, lost, account, phone.key.seed).open() }
        assertThrows(LostReply::class.java) { ApprovalAnswering(phone.prompt, lost, account, phone.key.seed).end(ApprovalAnswering.Ending.DENIED) }
    }

    @Test
    fun theAskingAndTheAnsweringPhoneAgreeOnTheCodeAndTheServerCanCheckTheApproval(): Unit = runBlocking {
        // Both halves against one server: what the asking phone shows is what the answering phone expects, and what
        // it signs verifies under its key for the request the asking phone made.
        val server = ApprovalServer()
        val asking = deviceSigningCreate()
        val ask = DeviceAsk.start(server.wire(session = null), token, "login", base64urlEncode(asking.publicKey), "Pixel 9")
        val phone = Phone(server)
        phone.flow.open()
        val shown = (ask.poll() as DeviceAsk.State.Code).code
        phone.flow.awaitReveal(every = 1)
        phone.flow.approve(shown)
        assertEquals(DeviceAsk.State.Approved, ask.poll())
        val step = DeviceStep(account, ask.requestId, "login", stepTokenDigest(token), base64urlEncode(asking.publicKey))
        assertTrue(deviceStepVerify(phone.key.publicKey, step, base64urlDecode(server.signature!!)))
    }

    /* The web's own requests (the fixture the core holds itself to): this phone expects the web's code and signs the web's statement. */
    @Test
    fun aRequestMadeInABrowserIsAnsweredToTheBrowsersBytes() {
        val cases = JSONObject(File("../../../crates/hushos-core/fixtures/web-device-approval.json").readText()).getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (index in 0 until cases.length()) {
            val made = cases.getJSONObject(index)
            val purpose = made.getString("purpose")
            val key = deviceSigningCreate()
            val prompt = ApprovalPrompt(
                made.getString("requestId"), purpose, "unknown", "web", "Chrome on Windows", "near Lyon, France", "2026-11-14T10:00:00.000Z", "2026-11-14T10:05:00.000Z",
                made.getString("tokenDigest"), made.getString("commitment"), null, null, null,
            )
            val signed = mutableListOf<String>()
            val denied = mutableListOf<String>()
            val approver = made.getString("approverKey")
            val entry = JSONObject().put("id", prompt.id).put("purpose", purpose).put("class", "unknown").put("device", JSONObject().put("kind", "web").put("name", "Chrome on Windows"))
                .put("createdAt", prompt.createdAt).put("expiresAt", prompt.expiresAt).put("tokenDigest", prompt.tokenDigest).put("commitment", prompt.commitment)
                .put("approverKey", approver).put("reveal", JSONObject().put("deviceSigningKey", made.getString("deviceSigningKey")).put("nonce", made.getString("nonce")))
            val listed = JSONObject().put("userId", "u").put("approvals", JSONArray().put(entry)).toString()
            val wire = ApprovalWire(Shared.Session("http://step.test", "s", account)) { method, path, body, _ ->
                when {
                    method == "GET" -> ApprovalWire.Reply(200, listed)
                    path.endsWith("/open") -> ApprovalWire.Reply(200, JSONObject().put("approverKey", approver).toString())
                    path.endsWith("/approve") -> { signed += JSONObject(body!!).getString("signature"); ApprovalWire.Reply(200, """{"approved":true}""") }
                    else -> { denied += JSONObject(body!!).getString("reason"); ApprovalWire.Reply(200, """{"ended":true}""") }
                }
            }
            // The browser's QR code is this request's.
            val scanning = ApprovalAnswering(prompt, wire, made.getString("userId"), key.seed)
            // The sheet says what is asked, by which device, and the place the server gave for it.
            assertTrue(purpose, scanning.asks.endsWith(" on Chrome on Windows, near Lyon, France"))
            assertTrue(purpose, scanning.openScanned(made.getString("qr")))
            assertTrue(purpose, scanning.revealed())
            // The browser's code is the code; one that is not it would have ended the request instead.
            val typing = ApprovalAnswering(prompt, wire, made.getString("userId"), key.seed)
            typing.open()
            assertTrue(typing.revealed())
            typing.approve(made.getString("code"))
            assertTrue(purpose, denied.isEmpty())
            // What is signed is the statement the browser and the server build.
            val step = DeviceStep(made.getString("userId"), prompt.id, purpose, prompt.tokenDigest, made.getString("deviceSigningKey"))
            assertEquals(purpose, made.getString("statement"), base64urlEncode(deviceStepStatement(step)))
            assertTrue(purpose, deviceStepVerify(key.publicKey, step, base64urlDecode(signed.single())))
        }
    }

    // The phone's own limit on prompts.

    private fun id(number: Int) = "00000000-0000-4000-8000-%012d".format(number)

    @Test
    fun noMoreThanFivePromptsADayForEachClassWhateverTheServerLists() {
        var kept = ""
        var saves = 0
        val limit = PromptLimit({ kept }, { kept = it; saves++ })
        val server = ApprovalServer()
        server.asked()
        // Nothing listed is nothing counted, and nothing written.
        server.set("ended")
        assertTrue(DeviceApprovals.list(server.wire(), limit, "2026-11-14").isEmpty())
        assertEquals(0, saves)
        // A server that lists eight requests from sign-ins it does not know: five are shown, in its order.
        server.others = (1..8).map { id(it) to "unknown" }
        val first = DeviceApprovals.list(server.wire(), limit, "2026-11-14").map { it.id }
        assertEquals((1..5).map(::id), first)
        // Asked again, the same five: a request shown once stays shown, and the sixth never appears that day.
        assertEquals(first, DeviceApprovals.list(server.wire(), limit, "2026-11-14").map { it.id })
        // The first five gone from the server's list, the others are still past the day's five.
        server.others = (6..8).map { id(it) to "unknown" }
        assertTrue(DeviceApprovals.list(server.wire(), limit, "2026-11-14").isEmpty())
        // The owner's own devices, and changes, have their own room: strangers' requests never used it up.
        server.others = (6..8).map { id(it) to "unknown" } + (11..17).map { id(it) to "known" } + (21..27).map { id(it) to "change" }
        assertEquals((11..15).map(::id) + (21..25).map(::id), DeviceApprovals.list(server.wire(), limit, "2026-11-14").map { it.id })
        // What was counted is kept by the phone, not by the server: a new limit over the same record shows no more.
        assertEquals((11..15).map(::id) + (21..25).map(::id), DeviceApprovals.list(server.wire(), PromptLimit({ kept }, { kept = it }), "2026-11-14").map { it.id })
        // A record that was wiped (sign-out) starts again, and so does the next day.
        // (The three strangers left in the list, then five of each of the other two classes.)
        assertEquals(13, DeviceApprovals.list(server.wire(), PromptLimit({ "" }, {}), "2026-11-14").size)
        assertEquals(13, DeviceApprovals.list(server.wire(), limit, "2026-11-15").size)
        assertEquals("2026-11-14", PromptLimit.day(java.time.LocalDate.of(2026, 11, 14)))
        // The record is one of the account's files: it goes with the account.
        val files = java.nio.file.Files.createTempDirectory("approvals").toFile()
        val cache = java.nio.file.Files.createTempDirectory("approvals-cache").toFile()
        val noBackup = java.nio.file.Files.createTempDirectory("approvals-no-backup").toFile()
        try {
            File(files, PromptLimit.FILE).writeText(kept)
            AccountStore(files, cache, noBackup).wipe()
            assertFalse(File(files, PromptLimit.FILE).exists())
        } finally {
            listOf(files, cache, noBackup).forEach { it.deleteRecursively() }
        }
    }

    // What the phone names, and what the settings say.

    private val asked: MutableList<Triple<String, String, JSONObject>> = Collections.synchronizedList(mutableListOf())
    private var server: HttpServer? = null

    /* A server over HTTP for the routes that go out under a session; what it was asked as (method, path?query, body). */
    private fun serving(answers: (method: String, path: String, body: JSONObject) -> Pair<Int, String>): Shared.Session {
        asked.clear()
        server?.stop(0)
        val made = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        made.createContext("/") { exchange ->
            val sent = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            val body = runCatching { JSONObject(sent) }.getOrDefault(JSONObject())
            val path = exchange.requestURI.path + (exchange.requestURI.query?.let { "?$it" } ?: "")
            asked += Triple(exchange.requestMethod, path, body.put("x-step-token", exchange.requestHeaders.getFirst("x-step-token") ?: JSONObject.NULL).put("cookie", exchange.requestHeaders.getFirst("Cookie") ?: JSONObject.NULL))
            val (code, text) = answers(exchange.requestMethod, exchange.requestURI.path, body)
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        made.start()
        server = made
        return Shared.Session("http://127.0.0.1:${made.address.port}", "session-token", account)
    }

    @org.junit.After
    fun stop() { server?.stop(0) }

    @Test
    fun aSignInAlwaysNamesAnotherDeviceAndAChangeOnlyWithAKeyToAskItWith() {
        // At sign-in: always, beside whatever else this phone can answer.
        val sent = mutableListOf<JSONObject>()
        Auth.finishNamed(StepAdverts.Memory(), "https://drive.example.org", """{"attemptToken":"a","loginResponse":"r","twoStepMethods":true}""", passkeys = false, { Auth.finishBody("a", "f", null, it) }) { body ->
            sent += JSONObject(body.toString())
            Auth.RawReply(200, "", JSONObject(), null, null)
        }
        assertEquals("""["device"]""", sent.single().getJSONArray("twoStepMethods").toString())
        assertEquals(1, sent.single().get("twoStep"))
        // At a change: only a phone that holds this account's device key names it, and is offered it.
        val step = """{"token":"$token","methods":["device","totp","backup"],"expiresAt":"2026-11-14T10:05:00.000Z"}"""
        var session = serving { _, _, _ -> 200 to step }
        val keyed = TwoStep.challenge(session, StepPurpose.PASSWORD, StepAdverts.Memory(), passkeys = false, device = true)!!
        assertEquals("""["device"]""", asked.single().third.getJSONArray("twoStepMethods").toString())
        assertEquals(StepMethod.DEVICE, keyed.methods.first())
        session = serving { _, _, _ -> 200 to step }
        val keyless = TwoStep.challenge(session, StepPurpose.PASSWORD, StepAdverts.Memory(), passkeys = false, device = false)!!
        assertEquals("[]", asked.single().third.getJSONArray("twoStepMethods").toString())
        // Even from a server that listed it all the same: there is no key to ask it with.
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP), keyless.methods)
        assertTrue(keyless.defaultUnavailable)
    }

    @Test
    fun aSignInsRequestsCarryNoSessionAndAChangesCarryItsOwn() {
        var session = serving { _, _, _ -> 200 to """{"state":"waiting"}""" }
        // A sign-in has no session: the token is the bearer, as a header on a look and in the body otherwise.
        ApprovalWire.signIn(session.origin).send("GET", "/api/auth/approvals/r", null, token)
        assertEquals(token, asked.single().third.getString("x-step-token"))
        assertTrue(asked.single().third.isNull("cookie"))
        session = serving { _, _, _ -> 200 to """{"approvals":[]}""" }
        ApprovalWire.signedIn(session).send("POST", "/api/auth/approvals/r/open", """{"ephemeralKey":"k"}""", null)
        assertEquals("hushos-session=session-token", asked.single().third.getString("cookie"))
        assertTrue(asked.single().third.isNull("x-step-token"))
        assertEquals("k", asked.single().third.getString("ephemeralKey"))
        assertEquals("POST", asked.single().first)
        // Nothing came back at all: unreachable, as every other account call says it.
        server?.stop(0)
        assertThrows(AuthUnreachable::class.java) { ApprovalWire.signedIn(session).send("GET", "/api/auth/approvals", null, null) }
    }

    private fun status(methods: String, on: Boolean = true, default: String? = null, other: String? = null): TwoStepStatus = TwoStepStatus.from(
        JSONObject("""{"on":$on,"methods":[$methods],"backupCodesLeft":10,"totpFrozen":false}""").apply {
            default?.let { put("defaultKind", it) }
            other?.let { put("otherDevice", JSONObject("""{"v":$it}""").get("v")) }
        },
    )!!

    private val deviceRow = """{"id":"d","kind":"device","name":null,"createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":null}"""
    private val appRow = """{"id":"a","kind":"totp","name":null,"createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":null}"""
    private val keyRow = """{"id":"k","kind":"webauthn","name":"Desk key","createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":null}"""

    @Test
    fun theSettingsAskForAnotherDeviceAndTheRowSaysOnOffOrThatItNeedsAnotherDevice() {
        // The settings name `device` among the kinds this build lists, on every server.
        val session = serving { _, _, _ -> 200 to """{"on":false,"methods":[],"backupCodesLeft":0,"totpFrozen":false,"otherDevice":true}""" }
        val read = TwoStep.status(session)!!
        assertEquals("/api/auth/two-step?methods=webauthn,device", asked.single().second)
        assertEquals(true, read.otherDevice)
        // A server from before the method says nothing of it: no row at all.
        val older = status("", on = false)
        assertNull(older.otherDevice)
        assertFalse(older.showsDevice)
        // Off, and it can be turned on: only on a phone with a device key of its own to ask with.
        val off = status("", on = false, other = "true")
        assertTrue(off.showsDevice)
        assertEquals("Off", off.deviceValue)
        assertTrue(off.canTurnOnDevice(ownKey = true))
        assertFalse(off.canTurnOnDevice(ownKey = false))
        // No other device could approve it: said, and nothing offered.
        val alone = status(appRow, other = "false")
        assertEquals("Needs another device", alone.deviceValue)
        assertFalse(alone.canTurnOnDevice(ownKey = true))
        // A 1 is not a yes.
        assertNull(status("", on = false, other = "1").otherDevice)
        // On: its only action is Turn off, whether or not it is the last method.
        val on = status("$appRow,$deviceRow", default = "totp", other = "true")
        assertEquals("On", on.deviceValue)
        assertFalse(on.canTurnOnDevice(ownKey = true))
        assertEquals("Turn off", on.removeWords(on.device!!))
        assertEquals("Remove", on.removeWords(on.app!!))
        assertFalse(on.last(on.device!!))
        assertTrue(status(deviceRow, default = "device").let { it.last(it.device!!) })
    }

    @Test
    fun theDefaultIsOfferedAmongWhateverKindsTheAccountHas() {
        // One kind: nothing to choose.
        val only = status(deviceRow, default = "device")
        assertFalse(only.isDefault(TwoStepStatus.DEVICE))
        assertFalse(only.canMakeDefault(TwoStepStatus.DEVICE))
        // The app and another device: the badge on the default, Make default on the other, and never on a kind the account has none of.
        val two = status("$appRow,$deviceRow", default = "totp")
        assertTrue(two.isDefault(TwoStepStatus.TOTP))
        assertTrue(two.canMakeDefault(TwoStepStatus.DEVICE))
        assertFalse(two.canMakeDefault(TwoStepStatus.TOTP))
        assertFalse(two.canMakeDefault(TwoStepStatus.WEBAUTHN))
        val three = status("$keyRow,$appRow,$deviceRow", default = "device")
        assertTrue(three.isDefault(TwoStepStatus.DEVICE))
        assertTrue(three.canMakeDefault(TwoStepStatus.WEBAUTHN) && three.canMakeDefault(TwoStepStatus.TOTP))
        assertEquals("Approve on another device is now the default.", TwoStepStatus.defaultSaid(TwoStepStatus.DEVICE))
        // The default is changed with the kind's own name, and no password.
        val session = serving { _, _, _ -> 200 to """{"defaultKind":"device"}""" }
        assertEquals("device", TwoStep.makeDefault(session, TwoStepStatus.DEVICE))
        assertEquals("PUT", asked.single().first)
        assertEquals("/api/auth/two-step/default", asked.single().second)
        assertEquals("device", asked.single().third.getString("kind"))
    }

    @Test
    fun turningItOffSaysWhatTheServerSaidHappenedAndTheLogNamesAnotherDevice() {
        val flow = TwoStepFlow().started()
        assertEquals("Approve on another device is off", flow.removed(on = true, app = false, device = true).finished)
        assertEquals("Two-step sign-in is off.", flow.removed(on = false, app = false, device = true).finished)
        assertEquals("Passkey or security key removed.", flow.removed(on = true, app = false).finished)
        fun words(kind: String, method: String? = null) = SecurityEvent("e", kind, method, null, null).words
        assertEquals("Signed in with your password and another device", words("sign-in", "device"))
        assertEquals("Wrong answer to the second step, with another device", words("step-failed", "device"))
        assertEquals("Approve on another device turned on", words("method-added", "device"))
        assertEquals("Approve on another device turned off", words("method-removed", "device"))
        assertEquals("Default changed to another device", words("default-changed", "device"))
    }

    @Test
    fun turningItOnIsConfirmedOnlyByTheServersOwnTwoAnswers() {
        val started = DeviceEnrolment("7c9e6679-7425-40de-944b-e07fc1f90ae7", token)
        val request = "40206e32-e631-4237-8b49-066d096eb7ed"
        fun confirming(status: Int, body: String): Result<TwoStep.DeviceConfirmed> {
            val session = serving { _, _, _ -> status to body }
            return runCatching { TwoStep.confirmDevice(session, started, request.uppercase()) }
        }
        // The codes: it turned the step on. What went out names the pending method, its token and the approved request.
        val turnedOn = confirming(200, """{"backupCodes":["7KQ2M-9XD4P","AAAAA-BBBBB"]}""").getOrThrow()
        assertEquals(TwoStep.DeviceConfirmed.TurnedOn(listOf("7KQ2M-9XD4P", "AAAAA-BBBBB")), turnedOn)
        assertEquals("/api/auth/two-step/device/${started.id}/confirm", asked.single().second)
        assertEquals(token, asked.single().third.getString("token"))
        assertEquals(request, asked.single().third.getString("requestId"))
        assertEquals(TwoStep.DeviceConfirmed.Added, confirming(200, """{"added":true}""").getOrThrow())
        // Not yet approved: pending, by its own code, and nothing changed.
        assertEquals(StepRefusal.PENDING, (confirming(409, """{"message":"Waiting for your other device.","code":"step-pending"}""").exceptionOrNull() as StepRefused).refusal)
        // Anything else with a 200, a gateway's page, a 5xx: nothing says whether it was turned on.
        for ((status, body) in listOf(200 to "{}", 200 to """{"added":false}""", 200 to """{"error":"proxy"}""", 200 to """{"backupCodes":[]}""", 502 to "<html></html>", 500 to """{"message":"Oops."}""")) {
            val lost = confirming(status, body).exceptionOrNull()
            assertTrue("$status $body: $lost", lost is LostReply)
            assertEquals(StepWords.LOST_DEVICE_ON, lost?.message)
        }
        assertEquals("The server’s answer didn’t arrive, so HushOS can’t tell whether approving on another device was turned on. Check before you try again.", StepWords.LOST_DEVICE_ON)
        assertTrue(confirming(401, """{"message":"Sign in again."}""").exceptionOrNull() is NotAuthenticated)
        // The flow: codes are kept before anything else; "added" for a step that was being turned on claims nothing.
        val flow = TwoStepFlow().deviceStarted(started)
        assertEquals(started, flow.device)
        assertEquals(listOf("7KQ2M-9XD4P", "AAAAA-BBBBB"), flow.deviceConfirmed(turnedOn, first = true).codes)
        assertNull(flow.deviceConfirmed(turnedOn, first = true).device)
        assertEquals("Approve on another device is on", flow.deviceConfirmed(TwoStep.DeviceConfirmed.Added, first = false).finished)
        val unsure = flow.deviceConfirmed(TwoStep.DeviceConfirmed.Added, first = true)
        assertNull(unsure.finished)
        assertEquals(StepWords.LOST_TURNED_ON, unsure.error)
        assertEquals(flow.reread + 1, unsure.reread)
        // A request that could not be made, or a confirmation that failed, goes back to the password and reads the settings again.
        val failed = flow.deviceFailed(StepRefused(StepRefusal.DEVICE_UNAVAILABLE, "No other device can approve this right now.", 409))
        assertNull(failed.device)
        assertEquals("No other device can approve this right now.", failed.error)
        assertNotEquals(flow.reread, failed.reread)
        // The pending method itself: read whole, or lost.
        fun reply(status: Int, body: String) = Auth.SessionReply(status, body, runCatching { JSONObject(body) }.getOrDefault(JSONObject()))
        assertEquals(started, TwoStep.deviceEnrolment(reply(200, """{"id":"${started.id}","token":"$token","expiresAt":"2026-11-14T10:10:00.000Z"}""")))
        assertThrows(LostReply::class.java) { TwoStep.deviceEnrolment(reply(200, """{"id":"x"}""")) }
        assertEquals(StepRefusal.REQUIRED, assertThrows(StepRefused::class.java) { TwoStep.deviceEnrolment(reply(403, """{"message":"Your second step is needed.","code":"two-step"}""")) }.refusal)
    }
}
