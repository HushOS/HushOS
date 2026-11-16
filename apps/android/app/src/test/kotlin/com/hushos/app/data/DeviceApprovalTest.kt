package com.hushos.app.data

import com.hushos.core.ApprovalEnded
import com.hushos.core.ApprovalPrompt
import com.hushos.core.DeviceStep
import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalCodeDraw
import com.hushos.core.approvalCodeNormalize
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
import com.hushos.core.deviceTurnOnStatement
import com.hushos.core.deviceTurnOnVerify
import com.hushos.core.randomBytes
import com.hushos.core.stepTokenDigest
import com.hushos.core.turnOnCodeDigest
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.time.LocalDate
import java.time.ZoneId
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
 * - it opens a request with a value of its own and keeps it: a value the server answers in its
 *   place, or a request listed as opened that this process holds no value for, ends the request;
 * - a name the server does not vouch for is said as the device's own words, with the day the
 *   device was added where it is one of the account's;
 * - turning the method on asks only the device the person chose, never one chosen for them, and
 *   the removal of the other devices keeps that one;
 * - the request that turns it on is answered the other way round: the answering phone, on a press
 *   and never after a scan, draws a code of its own, signs the request with the code's digest in
 *   it, posts the signature and the digest and never the code, and hands the code back to show;
 *   an approval whose reply was lost is sent again as the same one, and no second code is drawn.
 *   The asking phone shows no code and no QR code and has none. Every other request is still
 *   signed only on its exact code, or after a scan of that very request, with no digest;
 * - a setup another session is already running is refused in the server's words;
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
        for (out in listOf(AskPhase.Starting, AskPhase.Waiting("qr"), AskPhase.Asked, AskPhase.Code("47 river"))) {
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

    private inner class Phone(server: ApprovalServer, limit: PromptLimit = PromptLimit({ "" }, {}), /* What this phone made in this process. */ val opened: OpenedValues = OpenedValues()) {
        val key = deviceSigningCreate()
        val wire = server.wire()
        /* The request as this phone first saw it listed, before it opened it. */
        val prompt: ApprovalPrompt = limit.shown(DeviceApprovals.listed(wire)).single { it.id == server.requestId }
        val flow = ApprovalAnswering(prompt, wire, account, key.seed, opened)
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
        assertNull(phone.flow.approve("  $digits-${word.uppercase()} "))
        assertNull(server.deniedFor)
        assertNotNull(server.signature)
        assertEquals("approved", server.state)
        // A sign-in's approval is the signature and nothing else: no digest, and no code drawn for it.
        assertEquals(setOf("signature"), server.calls("/approve").single().body.keys().asSequence().toSet())
        assertNull(server.codeDigest)
        assertTrue(phone.opened.isEmpty)
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

    // The answering phone's own value.

    @Test
    fun aValueTheServerAnswersInPlaceOfThisPhonesOwnEndsTheRequestAndNothingIsSigned() {
        val server = ApprovalServer()
        val asked = server.asked()
        val phone = Phone(server)
        // The server answers the open with a value of its own: it has seen the commitment by now, and could pick one to steer the code.
        server.echoes = random32()
        val refused = assertThrows(ApprovalProblem.NotOwnValue::class.java) { phone.flow.open() }
        assertEquals("The server changed this device’s part of the code, so nothing was approved. Ask again on the other device.", refused.message)
        // What went out was this phone's own; what came back was not, and the request is ended as a mismatch (not a failed step).
        assertNotEquals(server.echoes, server.calls("/open").single().body.getString("ephemeralKey"))
        assertEquals("mismatch", server.deniedFor)
        // Nothing of it is kept, nothing is looked for, and nothing is ever signed, whatever is then revealed.
        assertTrue(phone.opened.isEmpty)
        server.reveal = asked
        val lists = server.calls("/api/auth/approvals").size
        assertFalse(phone.flow.revealed())
        assertEquals(lists, server.calls("/api/auth/approvals").size)
        assertThrows(Unanswered::class.java) { phone.flow.approve(null) }
        assertTrue(server.calls("/approve").isEmpty())
        assertNull(server.signature)
    }

    @Test
    fun aRequestListedAsOpenedThatThisProcessHoldsNoValueForIsRefusedWithoutOpeningIt() {
        // The list says this phone opened the request, and this process made no value for it: the app was restarted
        // since, or the server made it up. The listed value is never adopted, and never sent back.
        val server = ApprovalServer()
        server.asked()
        server.listedApproverKey = random32()
        val phone = Phone(server)
        assertEquals(server.listedApproverKey, phone.prompt.approverKey)
        val refused = assertThrows(ApprovalProblem.NotOwnValue::class.java) { phone.flow.open() }
        assertEquals("This request was opened before HushOS was restarted. Ask again on the other device.", refused.message)
        assertTrue(server.calls("/open").isEmpty())
        assertEquals("mismatch", server.deniedFor)
        assertNull(server.signature)
        // A scan of the right code does no better: the request is not opened, and does not count as scanned.
        val second = ApprovalServer()
        second.asked()
        second.listedApproverKey = random32()
        val scanning = Phone(second)
        assertThrows(ApprovalProblem.NotOwnValue::class.java) { scanning.flow.openScanned(approvalQr(second.requestId, second.commitment!!)) }
        assertTrue(second.calls("/open").isEmpty())
        assertFalse(scanning.flow.scanned)
        assertEquals("mismatch", second.deniedFor)
    }

    @Test
    fun anOpenWhoseReplyWasLostIsSentAgainWithTheSameValueAndTheRequestGoesOn() {
        val server = ApprovalServer()
        val asked = server.asked()
        val phone = Phone(server)
        // The server took this phone's value; its answer never arrived.
        server.loseOpenReply = true
        assertThrows(Unanswered::class.java) { phone.flow.open() }
        val sent = server.calls("/open").single().body.getString("ephemeralKey")
        assertEquals(sent, server.approverKey)
        // Tried again: the same value, which is the one the server holds, so its echo is this phone's own.
        server.loseOpenReply = false
        phone.flow.open()
        assertEquals(listOf(sent, sent), server.calls("/open").map { it.body.getString("ephemeralKey") })
        assertNull(server.deniedFor)
        server.reveal = asked
        server.state = "revealed"
        assertTrue(phone.flow.revealed())
        phone.flow.approve(deviceStepCode(signedStep(server, asked), sent, asked.second))
        assertNotNull(server.signature)
    }

    @Test
    fun aRequestOpenedAgainInTheSameProcessSendsTheSameValueAndKeepsTheCommitmentSeenFirst() {
        val server = ApprovalServer()
        val asked = server.asked()
        val phone = Phone(server)
        phone.flow.open()
        val sent = server.calls("/open").single().body.getString("ephemeralKey")
        // The sheet was closed, and the request is answered again from a later listing. By now the list says it is
        // opened; this server also lists another value for this phone, and another commitment.
        val swapped = random32() to random32()
        server.listedApproverKey = random32()
        server.listedCommitment = deviceStepCommitment("login", server.tokenDigest!!, swapped.first, swapped.second)
        val later = DeviceApprovals.listed(phone.wire).single()
        assertNotEquals(phone.prompt.commitment, later.commitment)
        assertNotEquals(sent, later.approverKey)
        val again = ApprovalAnswering(later, phone.wire, account, phone.key.seed, phone.opened)
        again.open()
        // The value this phone made is sent again, never the listed one.
        assertEquals(listOf(sent, sent), server.calls("/open").map { it.body.getString("ephemeralKey") })
        // The honest reveal is held to the commitment seen first, and the code is worked out from this phone's own value.
        server.reveal = asked
        server.state = "revealed"
        assertTrue(again.revealed())
        again.approve(deviceStepCode(signedStep(server, asked), sent, asked.second))
        assertNull(server.deniedFor)
        assertNotNull(server.signature)

        // A reveal that fits only the commitment listed later is not what this phone saw before it opened: refused.
        val lying = ApprovalServer()
        lying.asked()
        val other = Phone(lying)
        other.flow.open()
        lying.listedCommitment = deviceStepCommitment("login", lying.tokenDigest!!, swapped.first, swapped.second)
        lying.listedReveal = swapped
        val reopened = ApprovalAnswering(DeviceApprovals.listed(other.wire).single(), other.wire, account, other.key.seed, other.opened)
        reopened.open()
        assertThrows(ApprovalProblem.Mismatch::class.java) { reopened.revealed() }
        assertEquals("mismatch", lying.deniedFor)
        assertNull(lying.signature)
        assertTrue(other.opened.isEmpty)
    }

    @Test
    fun aNameTheServerDoesNotVouchForIsSaidAsTheDevicesOwnWordsAndAChosenPhoneIsTold() {
        // A stranger with the password names their browser as they like: the prompt says the words are the device's own.
        val server = ApprovalServer()
        server.asked()
        server.deviceName = "Maya’s Laptop"
        server.selfNamed = true
        server.location = "near Lyon, France"
        val stranger = Phone(server)
        assertEquals("Sign-in on a new device calling itself “Maya’s Laptop”, near Lyon, France", stranger.flow.asks)
        // The list's rows say what the sheet says.
        assertEquals(stranger.flow.asks, DeviceApprovals.asks(stranger.prompt))
        assertFalse(stranger.flow.chosen)
        // A reply that does not say (an older server) is not read as one of the account's devices.
        server.selfNamed = null
        assertEquals("Sign-in on a new device calling itself “Maya’s Laptop”, near Lyon, France", Phone(server).flow.asks)
        // One of the account's own devices, by the server's record of it, which chose this phone to approve.
        val own = ApprovalServer()
        own.asked(purpose = "device-approval")
        own.deviceName = "Maya’s Laptop"
        own.selfNamed = false
        own.chosen = true
        val known = Phone(own)
        assertEquals("Turn on Approve on another device on Maya’s Laptop", known.flow.asks)
        assertTrue(known.flow.chosen)
        assertEquals("The other device asked for this device to approve.", StepWords.APPROVAL_CHOSEN)
    }

    @Test
    fun aDeviceOfAnAccountWithNoSecondStepIsSaidInItsOwnWordsWithTheDayItWasAdded() {
        val utc = ZoneId.of("UTC")
        val today = LocalDate.of(2026, 11, 16)
        // The request that first turns the method on: the account has no second step, so the asking device is
        // whoever signed in with the password, under whatever name. The server marks the name as the device's own
        // word and says when the device was added.
        val server = ApprovalServer()
        server.asked(purpose = DeviceEnrolment.PURPOSE)
        server.deviceName = "Maya’s Laptop"
        server.selfNamed = true
        server.chosen = true
        fun listed(addedAt: String?): ApprovalPrompt {
            server.addedAt = addedAt
            return DeviceApprovals.listed(server.wire()).single()
        }
        val prompt = listed("2026-11-14T12:00:00.000Z")
        assertEquals("2026-11-14T12:00:00.000Z", prompt.deviceAddedAt)
        assertEquals("Turn on Approve on another device on a device calling itself “Maya’s Laptop”, added 14 Nov", DeviceApprovals.asks(prompt, today, utc))
        // The day on this phone's own calendar, and the year when it is another one.
        assertEquals("Turn on Approve on another device on a device calling itself “Maya’s Laptop”, added 15 Nov", DeviceApprovals.asks(prompt, today, ZoneId.of("Pacific/Auckland")))
        assertEquals(
            "Turn on Approve on another device on a device calling itself “Maya’s Laptop”, added 3 Sept 2025",
            DeviceApprovals.asks(listed("2025-09-03T12:00:00.000Z"), today, utc),
        )
        // The sheet's title and the Devices row are those words, for today on this phone.
        val phone = Phone(server)
        assertEquals(DeviceApprovals.asks(phone.prompt), phone.flow.asks)
        assertTrue(phone.flow.asks, phone.flow.asks.endsWith("“Maya’s Laptop”, added ${DeviceApprovals.addedDay("2025-09-03T12:00:00.000Z")}"))
        // No instant, one the core does not read as an instant, or one that is no date: no day is said, and the
        // device is a new one calling itself that.
        val unsaid = "Turn on Approve on another device on a new device calling itself “Maya’s Laptop”"
        for (addedAt in listOf(null, "yesterday", "2026-13-45T99:99:99.000Z")) assertEquals("$addedAt", unsaid, DeviceApprovals.asks(listed(addedAt), today, utc))
        assertNull(DeviceApprovals.addedDay(null))
        assertNull(DeviceApprovals.addedDay("2026-13-45T99:99:99.000Z"))
        // A name the server vouches for is never said with a day, whatever it lists.
        server.selfNamed = false
        assertEquals("Turn on Approve on another device on Maya’s Laptop", DeviceApprovals.asks(listed("2026-11-14T09:00:00.000Z"), today, utc))
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
                made.getString("requestId"), purpose, "unknown", "web", "Chrome on Windows", null, "near Lyon, France", false, false, "2026-11-14T10:00:00.000Z", "2026-11-14T10:05:00.000Z",
                made.getString("tokenDigest"), made.getString("commitment"), null, null, null,
            )
            val signed = mutableListOf<JSONObject>()
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
                    path.endsWith("/approve") -> { signed += JSONObject(body!!); ApprovalWire.Reply(200, """{"approved":true}""") }
                    else -> { denied += JSONObject(body!!).getString("reason"); ApprovalWire.Reply(200, """{"ended":true}""") }
                }
            }
            // The value this phone opens with is its own; here it makes the one the fixture's code was worked out from.
            // So is the code it draws for the request that turns the method on; here it draws the browser's.
            val turnOn = made.optJSONObject("turnOn")
            val opened = OpenedValues({ approver }, { turnOn!!.getString("code") })
            // The browser's QR code is this request's.
            val scanning = ApprovalAnswering(prompt, wire, made.getString("userId"), key.seed, opened)
            // The sheet says what is asked, by which device, and the place the server gave for it.
            assertTrue(purpose, scanning.asks.endsWith(" on Chrome on Windows, near Lyon, France"))
            // The request that turns the method on is the other way round: its QR code answers nothing, and what the
            // press hands back to show is the code this phone drew, never the one both devices can work out.
            val turnsOn = purpose == DeviceEnrolment.PURPOSE
            assertEquals(purpose, turnsOn, turnOn != null)
            assertEquals(purpose, !turnsOn, scanning.openScanned(made.getString("qr")))
            assertEquals(purpose, !turnsOn, scanning.revealed())
            // The browser's code is the code; one that is not it would have ended the request instead.
            val typing = ApprovalAnswering(prompt, wire, made.getString("userId"), key.seed, opened)
            typing.open()
            assertTrue(typing.revealed())
            val step = DeviceStep(made.getString("userId"), prompt.id, purpose, prompt.tokenDigest, made.getString("deviceSigningKey"))
            if (turnOn != null) {
                assertNotEquals(made.getString("code"), turnOn.getString("code"))
                assertEquals(turnOn.getString("code"), typing.approve(null))
                assertTrue(purpose, denied.isEmpty())
                // What went out is the digest the browser and the server build for that code, and a signature over
                // their statement with the digest in it: an approval of that code, and not an ordinary approval.
                val sent = signed.single()
                assertEquals(setOf("signature", "codeDigest"), sent.keys().asSequence().toSet())
                assertEquals(turnOn.getString("codeDigest"), sent.getString("codeDigest"))
                assertEquals(turnOn.getString("statement"), base64urlEncode(deviceTurnOnStatement(step, sent.getString("codeDigest"))))
                val signature = base64urlDecode(sent.getString("signature"))
                assertTrue(deviceTurnOnVerify(key.publicKey, step, turnOn.getString("codeDigest"), signature))
                assertFalse(deviceStepVerify(key.publicKey, step, signature))
                continue
            }
            assertNull(purpose, typing.approve(made.getString("code")))
            assertTrue(purpose, denied.isEmpty())
            // What is signed is the statement the browser and the server build, and it goes with no digest.
            assertEquals(purpose, made.getString("statement"), base64urlEncode(deviceStepStatement(step)))
            assertEquals(purpose, setOf("signature"), signed.single().keys().asSequence().toSet())
            assertTrue(purpose, deviceStepVerify(key.publicKey, step, base64urlDecode(signed.single().getString("signature"))))
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
        assertTrue(limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-14").isEmpty())
        assertEquals(0, saves)
        // A server that lists eight requests from sign-ins it does not know: five are shown, in its order.
        server.others = (1..8).map { id(it) to "unknown" }
        val first = limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-14").map { it.id }
        assertEquals((1..5).map(::id), first)
        // Asked again, the same five: a request shown once stays shown, and the sixth never appears that day.
        assertEquals(first, limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-14").map { it.id })
        // The first five gone from the server's list, the others are still past the day's five.
        server.others = (6..8).map { id(it) to "unknown" }
        assertTrue(limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-14").isEmpty())
        // The owner's own devices, and changes, have their own room: strangers' requests never used it up.
        server.others = (6..8).map { id(it) to "unknown" } + (11..17).map { id(it) to "known" } + (21..27).map { id(it) to "change" }
        assertEquals((11..15).map(::id) + (21..25).map(::id), limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-14").map { it.id })
        // What was counted is kept by the phone, not by the server: a new limit over the same record shows no more.
        assertEquals((11..15).map(::id) + (21..25).map(::id), PromptLimit({ kept }, { kept = it }).shown(DeviceApprovals.listed(server.wire()), "2026-11-14").map { it.id })
        // A record that was wiped (sign-out) starts again, and so does the next day.
        // (The three strangers left in the list, then five of each of the other two classes.)
        assertEquals(13, PromptLimit({ "" }, {}).shown(DeviceApprovals.listed(server.wire()), "2026-11-14").size)
        assertEquals(13, limit.shown(DeviceApprovals.listed(server.wire()), "2026-11-15").size)
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

    private fun status(methods: String, on: Boolean = true, default: String? = null, other: String? = null, approvers: String? = null): TwoStepStatus = TwoStepStatus.from(
        JSONObject("""{"on":$on,"methods":[$methods],"backupCodesLeft":10,"totpFrozen":false}""").apply {
            default?.let { put("defaultKind", it) }
            other?.let { put("otherDevice", JSONObject("""{"v":$it}""").get("v")) }
            approvers?.let { put("approvers", JSONArray("[$it]")) }
        },
    )!!

    private val laptop = """{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","kind":"web","name":"Maya’s Laptop","createdAt":"2026-11-02T09:30:00.000Z"}"""
    private val tablet = """{"id":"40206e32-e631-4237-8b49-066d096eb7ed","kind":"ios","name":null,"createdAt":"2026-10-20T18:00:00.000Z"}"""

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
        val off = status("", on = false, other = "true", approvers = laptop)
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
        val on = status("$appRow,$deviceRow", default = "totp", other = "true", approvers = laptop)
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
            return runCatching { TwoStep.confirmDevice(session, started, request.uppercase(), "07 river") }
        }
        // The codes: it turned the step on. What went out names the pending method, its token, the approved request, and the code typed here.
        val turnedOn = confirming(200, """{"backupCodes":["7KQ2M-9XD4P","AAAAA-BBBBB"]}""").getOrThrow()
        assertEquals(TwoStep.DeviceConfirmed.TurnedOn(listOf("7KQ2M-9XD4P", "AAAAA-BBBBB")), turnedOn)
        assertEquals("/api/auth/two-step/device/${started.id}/confirm", asked.single().second)
        assertEquals(token, asked.single().third.getString("token"))
        assertEquals(request, asked.single().third.getString("requestId"))
        assertEquals("07 river", asked.single().third.getString("code"))
        // A code that was not the approving device's: refused by its own code, in the server's words. That request
        // is over; the pending method, its token and the chosen device stand, and nothing is read again.
        val wrong = confirming(409, """{"message":"That code didn’t match, so nothing was turned on.","code":"device-code"}""").exceptionOrNull() as StepRefused
        assertEquals(StepRefusal.DEVICE_CODE, wrong.refusal)
        assertEquals("That code didn’t match, so nothing was turned on.", wrong.message)
        val chosen = TwoStepStatus.Approver("a", null, null, null)
        val waiting = TwoStepFlow().deviceStarted(started, chosen)
        assertEquals(waiting, waiting.started().deviceCodeRefused())
        assertEquals(started, waiting.started().deviceCodeRefused().device)
        assertEquals(chosen, waiting.started().deviceCodeRefused().approver)
        // Were it ever met at a step, it is a request that ended: nothing is taken away, and it is no wrong answer.
        val ways = listOf(StepMethod.DEVICE, StepMethod.TOTP)
        assertEquals(StepOutcome.Again("That code didn’t match, so nothing was turned on.", false, ways), StepOutcome.after(wrong, ways, StepMethod.DEVICE))
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
        val approver = TwoStepStatus.Approver("40206e32-e631-4237-8b49-066d096eb7ed", "ios", "Maya’s iPad", "2026-11-02T09:30:00.000Z")
        val flow = TwoStepFlow().deviceStarted(started, approver)
        assertEquals(started, flow.device)
        // The chosen device is named for as long as it is being asked, and no longer.
        assertEquals(approver, flow.approver)
        assertNull(flow.deviceConfirmed(turnedOn, first = true).approver)
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
        assertNull(failed.approver)
        assertEquals("No other device can approve this right now.", failed.error)
        assertNotEquals(flow.reread, failed.reread)
        // The pending method itself: read whole, or lost.
        fun reply(status: Int, body: String) = Auth.SessionReply(status, body, runCatching { JSONObject(body) }.getOrDefault(JSONObject()))
        assertEquals(started, TwoStep.deviceEnrolment(reply(200, """{"id":"${started.id}","token":"$token","expiresAt":"2026-11-14T10:10:00.000Z"}""")))
        assertThrows(LostReply::class.java) { TwoStep.deviceEnrolment(reply(200, """{"id":"x"}""")) }
        assertEquals(StepRefusal.REQUIRED, assertThrows(StepRefused::class.java) { TwoStep.deviceEnrolment(reply(403, """{"message":"Your second step is needed.","code":"two-step"}""")) }.refusal)
        // Another session of the account is already turning the method on: refused by its own code, in the server's words.
        val busy = assertThrows(StepRefused::class.java) {
            TwoStep.deviceEnrolment(reply(409, """{"message":"Another of your devices is turning this on. Try again in a few minutes.","code":"device-busy"}"""))
        }
        assertEquals(StepRefusal.DEVICE_BUSY, busy.refusal)
        assertEquals("Another of your devices is turning this on. Try again in a few minutes.", busy.message)
    }

    // Turning it on: the device the person chose.

    @Test
    fun theDevicesThatCouldApproveAreListedToChooseFromAndNoneIsEverChosenForThePerson() {
        // One: listed with what Devices says of it, and not chosen. Its name is its own words, and anyone with the password can give it.
        val one = status("", on = false, other = "true", approvers = laptop)
        val first = TwoStepStatus.Approver("7c9e6679-7425-40de-944b-e07fc1f90ae7", "web", "Maya’s Laptop", "2026-11-02T09:30:00.000Z")
        assertEquals(listOf(first), one.approvers)
        assertNull(one.approver(null))
        // Chosen only by the person's pick.
        assertEquals(first, one.approver(first.id))
        assertEquals("Maya’s Laptop", first.shownName)
        assertEquals("A web browser · Added 2 Nov", first.detail { if (it == first.createdAt) "2 Nov" else null })
        // Several: none is chosen until the person picks, and an id the server did not list chooses nothing.
        val two = status("", on = false, other = "true", approvers = "$laptop,$tablet")
        assertEquals(2, two.approvers.size)
        assertNull(two.approver(null))
        assertNull(two.approver("00000000-0000-4000-8000-000000000001"))
        val unnamed = two.approver("40206e32-e631-4237-8b49-066d096eb7ed")!!
        assertEquals("Unknown device", unnamed.shownName)
        assertEquals("iPhone · Added 20 Oct", unnamed.detail { "20 Oct" })
        assertEquals("Unknown device", TwoStepStatus.Approver("a", null, "  ", null).shownName)
        assertEquals("", TwoStepStatus.Approver("a", null, null, null).detail { it })
        // A row without an id is not one to choose; with nobody to choose there is no Turn on (the server refuses a request that names none).
        assertEquals(listOf(first), status("", on = false, other = "true", approvers = """{"kind":"web","name":"No id"},7,$laptop""").approvers)
        val none = status("", on = false, other = "true")
        assertTrue(none.approvers.isEmpty())
        assertFalse(none.canTurnOnDevice(ownKey = true))
        assertTrue(one.canTurnOnDevice(ownKey = true))
        // The words on the page.
        assertEquals("Device that will approve", StepWords.APPROVER_HEADING)
        assertEquals("Choose the device that will approve.", StepWords.APPROVER_CHOOSE)
        assertEquals("Open HushOS on Maya’s Laptop and choose Answer.", StepWords.askOpen(first.shownName))
        assertEquals("Approve on Unknown device", StepWords.approveOn(unnamed.shownName))
        assertEquals("Code on Maya’s Laptop", StepWords.codeOn(first.shownName))
        assertEquals("Code for your other device", StepWords.ASK_CODE)
        assertEquals("All but this one and the one that approves. They’ll need to sign in again.", StepWords.OTHERS_BUT_APPROVER)
    }

    @Test
    fun aRequestToTurnItOnNamesTheChosenDeviceAndASignInNamesNone() {
        val server = ApprovalServer()
        DeviceAsk.start(server.wire(), token, DeviceEnrolment.PURPOSE, random32(), "Pixel 9", approverDeviceId = "7C9E6679-7425-40DE-944B-E07FC1F90AE7")
        assertEquals("7c9e6679-7425-40de-944b-e07fc1f90ae7", server.calls("/api/auth/approvals").single().body.getString("approverDeviceId"))
        val signIn = ApprovalServer()
        begin(signIn)
        assertFalse(signIn.calls("/api/auth/approvals").single().body.has("approverDeviceId"))
        // A request to turn it on that named none is refused in the server's words, by its own code, and the page says them.
        val refusing = ApprovalServer()
        refusing.refusesStart = 409 to """{"message":"Choose which of your devices will approve.","code":"device-choice"}"""
        val refused = assertThrows(StepRefused::class.java) { begin(refusing, purpose = DeviceEnrolment.PURPOSE) }
        assertEquals(StepRefusal.DEVICE_CHOICE, refused.refusal)
        val approver = TwoStepStatus.Approver("7c9e6679-7425-40de-944b-e07fc1f90ae7", "web", null, null)
        assertEquals("Choose which of your devices will approve.", TwoStepFlow().deviceStarted(DeviceEnrolment("m", token), approver).deviceFailed(refused).error)
        // At a step it takes no way of answering away, and is never a wrong answer.
        val all = listOf(StepMethod.DEVICE, StepMethod.TOTP)
        assertEquals(StepOutcome.Again("Choose which of your devices will approve.", false, all), StepOutcome.after(refused, all, StepMethod.DEVICE))
    }

    // Turning it on: the approving phone draws the code.

    /* Another code than `code`, and still a code. */
    private fun another(code: String): String = code.split(" ").let { (digits, word) -> "%02d $word".format((digits.toInt() + 1) % 100) }

    @Test
    fun theRequestThatTurnsItOnShowsNoCodeAndNoQrCodeWhereItIsAskedAndHasNone() {
        val server = ApprovalServer()
        server.purpose = DeviceEnrolment.PURPOSE
        val key = random32()
        val ask = DeviceAsk.start(server.wire(), token, DeviceEnrolment.PURPOSE, key, "Pixel 9", approverDeviceId = "7c9e6679-7425-40de-944b-e07fc1f90ae7")
        // Nothing for a camera: this request is never answered by a scan. Every other request still has its QR code.
        assertTrue(ask.turnsOn)
        assertNull(ask.qr)
        assertFalse(begin(ApprovalServer()).turnsOn)
        assertEquals(DeviceAsk.State.Waiting, ask.poll())
        // The chosen device opened it: this phone reveals as for any request, and hands no code to its screen.
        server.open()
        assertEquals(DeviceAsk.State.Opened, ask.poll())
        assertEquals("revealed", server.state)
        assertEquals(DeviceAsk.State.Opened, ask.poll())
        // Approved: still no code here. The one that device shows is its own, and this phone only passes on what is typed.
        server.set("approved")
        assertEquals(DeviceAsk.State.Approved, ask.poll())
        // A sign-in's code is still this phone's to show.
        val signIn = ApprovalServer()
        val other = begin(signIn)
        signIn.open()
        assertTrue(other.poll() is DeviceAsk.State.Code)
    }

    /* The request that turns the method on, asked by one phone and opened by another, with the reveal checked: Approve is next. */
    private inner class TurningOn {
        val server = ApprovalServer().apply { purpose = DeviceEnrolment.PURPOSE }
        val key = random32()
        val ask = DeviceAsk.start(server.wire(), token, DeviceEnrolment.PURPOSE, key, "Pixel 9", approverDeviceId = "7c9e6679-7425-40de-944b-e07fc1f90ae7")
        /* How many codes the approving phone drew. */
        var draws = 0
        val phone = Phone(server, opened = OpenedValues(draw = { draws++; approvalCodeDraw() }))
        /* What the approving phone signs over: this account, this request, its token, and the asking phone's key. */
        val step = DeviceStep(account, server.requestId, DeviceEnrolment.PURPOSE, stepTokenDigest(token), key)

        init {
            assertTrue(phone.flow.turnsOn)
            phone.flow.open()
            // The asking phone reveals once the answering one has fixed its value; the reveal is checked against the commitment as always.
            ask.poll()
            assertTrue(phone.flow.revealed())
        }

        /* The code both phones could work out from what they hold, which is not the one that turns the method on. */
        fun derived(): String = deviceStepCode(step, server.approverKey!!, server.reveal!!.second)
    }

    @Test
    fun theRequestThatTurnsItOnIsApprovedWithACodeThisPhoneDrawsAndSignsTheDigestOfAndNeverSends() {
        // (shown, derived) for each run: the code is from fresh randomness, so it is the derived one only by chance (1 in 204,800).
        val runs = (1..4).map {
            val made = TurningOn()
            // The press: signed with nothing typed, and what comes back is the code to show.
            assertEquals(0, made.draws)
            val shown = made.phone.flow.approve(null)!!
            assertEquals(1, made.draws)
            assertEquals(shown, approvalCodeNormalize(shown))
            assertNull(made.server.deniedFor)
            // What went out: the signature and the digest of that code for this request. Nothing else.
            val sent = made.server.calls("/approve").single().body
            assertEquals(setOf("signature", "codeDigest"), sent.keys().asSequence().toSet())
            val digest = sent.getString("codeDigest")
            assertEquals(turnOnCodeDigest(made.server.requestId, shown), digest)
            assertEquals(digest, made.server.codeDigest)
            // The signature is this phone's device key's over the statement with that digest in it: an approval of that
            // code and no other, and not an ordinary approval of the request.
            val signature = base64urlDecode(sent.getString("signature"))
            assertTrue(deviceTurnOnVerify(made.phone.key.publicKey, made.step, digest, signature))
            assertFalse(deviceTurnOnVerify(made.phone.key.publicKey, made.step, turnOnCodeDigest(made.server.requestId, another(shown)), signature))
            assertFalse(deviceStepVerify(made.phone.key.publicKey, made.step, signature))
            // The code itself is in nothing either phone sent: only a person reading this phone's screen has it.
            for (call in made.server.calls) {
                assertFalse("${call.method} ${call.path}", call.body.toString().contains(shown) || call.path.contains(shown) || call.body.has("code"))
            }
            // The asking phone sees an approval, and nothing that gives the code.
            assertEquals(DeviceAsk.State.Approved, made.ask.poll())
            shown to made.derived()
        }
        assertTrue("$runs", runs.any { (shown, derived) -> shown != derived })
        // A reveal that is not the commitment is refused for this request as for any other, and nothing is signed or drawn.
        val lying = ApprovalServer()
        lying.asked(purpose = DeviceEnrolment.PURPOSE)
        val fooled = Phone(lying)
        fooled.flow.open()
        lying.listedReveal = random32() to random32()
        assertThrows(ApprovalProblem.Mismatch::class.java) { fooled.flow.revealed() }
        assertThrows(Unanswered::class.java) { fooled.flow.approve(null) }
        assertNull(lying.signature)
        assertTrue(lying.calls("/approve").isEmpty())
        assertTrue(fooled.opened.isEmpty)
    }

    @Test
    fun anApprovalWhoseReplyWasLostIsSentAgainAsTheSameOneAndNoSecondCodeIsEverDrawn() {
        val made = TurningOn()
        // The server took the approval, with its digest; the answer never arrived, and no code was shown.
        made.server.loseApproveReply = true
        assertThrows(LostReply::class.java) { made.phone.flow.approve(null) }
        val first = made.server.calls("/approve").single().body
        assertEquals("approved", made.server.state)
        assertEquals(first.getString("codeDigest"), made.server.codeDigest)
        // Approve again: the same approval, which the server takes as the one it has. A second code would be refused.
        val shown = made.phone.flow.approve(null)!!
        val again = made.server.calls("/approve").last().body
        assertEquals(2, made.server.calls("/approve").size)
        assertEquals(first.getString("codeDigest"), again.getString("codeDigest"))
        assertEquals(first.getString("signature"), again.getString("signature"))
        // And the code shown is the one whose digest went out the first time: one code was drawn, at the first press.
        assertEquals(first.getString("codeDigest"), turnOnCodeDigest(made.server.requestId, shown))
        assertEquals(1, made.draws)
        // Nothing came back at all, and nothing reached the server (no connection): the code drawn at that press is
        // still the request's, and the next press sends it.
        val cut = TurningOn()
        val offline = ApprovalAnswering(cut.phone.prompt, ApprovalWire(Shared.Session("http://step.test", "s", account)) { method, path, body, stepToken ->
            if (path.endsWith("/approve")) throw AuthUnreachable() else cut.server.wire().send(method, path, body, stepToken)
        }, account, cut.phone.key.seed, cut.phone.opened)
        offline.open()
        assertTrue(offline.revealed())
        assertThrows(AuthUnreachable::class.java) { offline.approve(null) }
        assertEquals(1, cut.draws)
        assertTrue(cut.server.calls("/approve").isEmpty())
        val later = cut.phone.flow.approve(null)!!
        // Pressed once more after it went through: the same approval, and the same code to show.
        assertEquals(later, cut.phone.flow.approve(null))
        assertEquals(1, cut.draws)
        assertEquals(setOf(turnOnCodeDigest(cut.server.requestId, later)), cut.server.calls("/approve").map { it.body.getString("codeDigest") }.toSet())
    }

    @Test
    fun theCodeDrawnForARequestIsKeptWithTheValueItWasOpenedWithAndGoesWithIt() {
        // Each draw is another code, so a second draw for a request would show.
        var draws = 0
        val values = OpenedValues(draw = { "%02d river".format(draws++) })
        val first = values.code("a")
        assertEquals(first, values.code("a"))
        assertEquals(1, draws)
        assertNotEquals(first, values.code("b"))
        assertFalse(values.isEmpty)
        // Done with (the sheet closed, the request denied or over): forgotten, and with it the code.
        values.forget("a")
        assertNotEquals(first, values.code("a"))
        // A request that left the list goes; one still listed or being answered stays.
        val kept = values.code("b")
        values.retain(setOf("b"))
        assertEquals(kept, values.code("b"))
        assertNotEquals(first, values.code("a").also { assertEquals(4, draws) })
        // The account went: everything made under it goes.
        values.clear()
        assertTrue(values.isEmpty)
        assertNotEquals(kept, values.code("b"))
        // Ending a request from the phone that answers it forgets what was drawn for it.
        val made = TurningOn()
        made.server.loseApproveReply = true
        assertThrows(LostReply::class.java) { made.phone.flow.approve(null) }
        assertFalse(made.phone.opened.isEmpty)
        made.phone.flow.end(ApprovalAnswering.Ending.DENIED)
        assertTrue(made.phone.opened.isEmpty)
        assertNull(made.server.codeDigest)
    }

    @Test
    fun aScanNeverAnswersTheRequestThatTurnsItOnAndNoOtherRequestIsApprovedUntypedAndUnscanned() {
        // This very request's own QR code, as a screen would show it: refused, with nothing opened, ended or signed.
        val server = ApprovalServer()
        val asked = server.asked(purpose = DeviceEnrolment.PURPOSE)
        val phone = Phone(server)
        assertFalse(phone.flow.openScanned(approvalQr(server.requestId, server.commitment!!)))
        assertFalse(phone.flow.scanned)
        assertTrue(server.calls("/open").isEmpty() && server.calls("/deny").isEmpty())
        assertEquals("waiting", server.state)
        assertTrue(phone.opened.isEmpty)
        // Unopened, it has nothing to approve with, whatever the server then lists.
        server.reveal = asked
        assertThrows(Unanswered::class.java) { phone.flow.approve(null) }
        assertNull(server.signature)
        // Every other request: with no scan, nothing typed is a wrong code. The request ends and nothing is signed.
        for (purpose in listOf("login", "password", "two-step")) {
            val other = ApprovalServer()
            val made = other.asked(purpose = purpose)
            val answering = Phone(other)
            assertFalse("$purpose", answering.flow.turnsOn)
            answering.flow.open()
            other.reveal = made
            other.state = "revealed"
            assertTrue(answering.flow.revealed())
            assertThrows("$purpose", ApprovalProblem.WrongCode::class.java) { answering.flow.approve(null) }
            assertEquals("wrong-code", other.deniedFor)
            assertNull(other.signature)
            assertTrue(other.calls("/approve").isEmpty())
        }
        // And one that was typed hands back no code: only the request that turns the method on has one to show.
        val typed = ApprovalServer()
        val made = typed.asked()
        val answering = Phone(typed)
        answering.flow.open()
        typed.reveal = made
        typed.state = "revealed"
        assertTrue(answering.flow.revealed())
        assertNull(answering.flow.approve(deviceStepCode(signedStep(typed, made), typed.approverKey!!, made.second)))
        assertNotNull(typed.signature)
    }

    @Test
    fun removingTheOtherDevicesKeepsTheOneThatApproves() {
        val session = serving { _, _, _ -> 200 to """{"removed":2}""" }
        // The password's proof needs the real server; what is held here is what goes with it.
        val proof = { _: Shared.Session, _: String -> JSONObject().put("attemptToken", "attempt").put("finishLoginRequest", "ke3") }
        assertEquals(2, Auth.removeOtherDevicesAt(session, "password here", keep = "7C9E6679-7425-40DE-944B-E07FC1F90AE7", proof = proof))
        val (method, path, body) = asked.single()
        assertEquals("DELETE", method)
        assertEquals("/api/auth/devices/others", path)
        assertEquals("7c9e6679-7425-40de-944b-e07fc1f90ae7", body.getString("keep"))
        assertEquals("attempt", body.getString("attemptToken"))
        assertEquals("ke3", body.getString("finishLoginRequest"))
        // Removing them by any other road (the authenticator app's turn-on, Devices' own button) keeps none.
        Auth.removeOtherDevicesAt(session, "password here", proof = proof)
        assertFalse(asked.last().third.has("keep"))
    }
}
