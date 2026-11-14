package com.hushos.app.ui

import com.hushos.app.data.ApprovalAnswering
import com.hushos.app.data.ApprovalServer
import com.hushos.app.data.ApprovalWire
import com.hushos.app.data.OpenedValues
import com.hushos.app.data.PromptLimit
import com.hushos.app.data.Shared
import com.hushos.app.data.TwoStep
import com.hushos.app.data.uptime
import com.hushos.core.deviceSigningCreate
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * The requests this phone may answer, as the app holds them (`ApprovalInbox`). What these hold:
 *
 * - they are listed and answered whether or not the server has two-step sign-in switched on: only
 *   the settings follow that flag (501), and an account that already has the step is still asked;
 * - everything held is one account's. The moment the phone's session is another one, the list,
 *   the request being answered and the values this phone opened requests with all go, even while
 *   a look for the earlier session is still out, and its reply then shows nothing.
 */
class ApprovalInboxTest {
    private val account = ApprovalServer.ACCOUNT
    private val another = "40206e32-e631-4237-8b49-066d096eb7ed"

    @org.junit.Before
    fun clock() { uptime = { 50_000L } }

    private var http: HttpServer? = null

    @org.junit.After
    fun stop() { http?.stop(0) }

    private suspend fun waitFor(what: String, met: () -> Boolean) {
        repeat(600) { if (met()) return; delay(5) }
        fail("Never happened: $what")
    }

    private fun key(userId: String) = Shared.DeviceIdentity(userId, "h", "d", deviceSigningCreate().seed)

    /* What the phone holds, which a test changes under the inbox as a sign-in elsewhere does, and what the inbox said. */
    private inner class Phone(scope: CoroutineScope, @Volatile var session: Shared.Session?, @Volatile var key: Shared.DeviceIdentity?, wire: (Shared.Session) -> ApprovalWire) {
        val said: MutableList<Pair<String, Boolean>> = Collections.synchronizedList(mutableListOf())
        val opened = OpenedValues()
        val inbox = ApprovalInbox(
            scope, { session }, { key }, wire, { PromptLimit({ "" }, {}) },
            sessionEnded = { fail("signed out") }, notify = { words, important -> said += words to important }, opened = opened,
        )
    }

    @Test
    fun requestsAreListedAndAnsweredOnAServerThatHasTwoStepSwitchedOff(): Unit = runBlocking {
        // TWO_STEP_ENABLED is off: the settings route answers 501, and the approvals routes answer as they always do.
        val approvals = ApprovalServer()
        approvals.asked()
        val asked: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val made = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        made.createContext("/") { exchange ->
            val path = exchange.requestURI.path
            asked += path
            val sent = exchange.requestBody.readBytes().toString(Charsets.UTF_8).ifEmpty { null }
            val (code, text) = if (path.startsWith("/api/auth/approvals")) approvals.wire().send(exchange.requestMethod, path, sent, null).let { it.status to it.text }
            else 501 to """{"message":"Two-step sign-in isn’t available on this server."}"""
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(code, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        made.start()
        http = made
        val session = Shared.Session("http://127.0.0.1:${made.address.port}", "session-token", account)
        // The settings: nothing of two-step is shown here.
        assertNull(withContext(Dispatchers.IO) { TwoStep.status(session) })
        // The inbox, over the same server: the request is listed, without asking the settings anything.
        val phone = Phone(this, session, key(account), ApprovalWire::signedIn)
        phone.inbox.loadNow()
        val prompt = phone.inbox.prompts.single()
        assertEquals(approvals.requestId, prompt.id)
        assertEquals(1, asked.count { it == "/api/auth/two-step" })
        // And it is answered: its sheet opens, says what is asked, and what it decides reaches the server.
        phone.inbox.answer(prompt)
        val sheet = phone.inbox.answering!!
        assertEquals("Sign-in on a new device calling itself “Chrome on Windows”", sheet.asks)
        assertNull(sheet.note)
        sheet.end(ApprovalAnswering.Ending.DENIED)
        waitFor("the close") { phone.said.isNotEmpty() }
        assertEquals(listOf("Denied" to false), phone.said.toList())
        assertEquals("denied", approvals.deniedFor)
        assertTrue(phone.inbox.prompts.isEmpty())
        assertNull(phone.inbox.answering)
        assertEquals(1, asked.count { it == "/api/auth/two-step" })
    }

    @Test
    fun aRequestThatChoseThisPhoneSaysSoUnderWhatIsAsked(): Unit = runBlocking {
        val server = ApprovalServer()
        server.asked(purpose = "device-approval")
        server.deviceName = "Maya’s Laptop"
        server.selfNamed = false
        server.chosen = true
        val session = Shared.Session("http://step.test", "session-token", account)
        val phone = Phone(this, session, key(account)) { server.wire(it) }
        phone.inbox.loadNow()
        phone.inbox.answer(phone.inbox.prompts.single())
        val sheet = phone.inbox.answering!!
        assertEquals("Turn on Approve on another device on Maya’s Laptop", sheet.asks)
        assertEquals("The other device asked for this device to approve.", sheet.note)
        phone.inbox.dismiss()
    }

    /* Two accounts on one phone, each with its own server; a look for the first can be held on its way back. */
    private inner class TwoAccounts(scope: CoroutineScope) {
        val first = Shared.Session("http://step.test", "token-a", account)
        val second = Shared.Session("http://step.test", "token-b", another)
        val firstServer = ApprovalServer().apply { asked() }
        val secondServer = ApprovalServer().apply { asked(purpose = "password") }
        /* The next list asked for under the first session waits at `release`; `held` says it has been asked for. */
        val hold = AtomicBoolean(false)
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val phone = Phone(scope, first, key(account)) { session ->
            if (session != first) secondServer.wire(session)
            else firstServer.wire(first).let { real ->
                ApprovalWire(first) { method, path, body, stepToken ->
                    val reply = real.send(method, path, body, stepToken)
                    if (method == "GET" && hold.compareAndSet(true, false)) { held.countDown(); release.await() }
                    reply
                }
            }
        }

        /* The other account signs in on the phone, by a road this inbox's own view model never saw (the file picker's sign-in). */
        fun switch() {
            phone.session = second
            phone.key = key(another)
        }

        /* Whatever a test finds, the held look is let go: a failed check must fail the test, not leave it waiting. */
        suspend fun <T> letGoAfter(block: suspend () -> T): T = try { block() } finally { release.countDown() }
    }

    @Test
    fun theMomentTheSessionIsAnothersEverythingHeldGoesAndALateListForTheEarlierOneShowsNothing(): Unit = runBlocking {
        val two = TwoAccounts(this)
        val phone = two.phone
        // Under the first account: its request is listed, being answered, and opened with a value this phone made.
        phone.inbox.loadNow()
        val prompt = phone.inbox.prompts.single()
        assertEquals("login", prompt.purpose)
        phone.inbox.answer(prompt)
        phone.inbox.answering!!.typing()
        waitFor("the open") { !phone.opened.isEmpty }
        // (The sheet's own first look for the reveal goes by before one is held.)
        delay(150)
        // A look for the first account is out, its reply on the way.
        two.hold.set(true)
        val late = launch { phone.inbox.loadNow() }
        two.letGoAfter {
            assertTrue("the look never went out", withContext(Dispatchers.IO) { two.held.await(10, TimeUnit.SECONDS) })
            // The phone is the second account's now, and the next look comes while the first one's is still out.
            two.switch()
            phone.inbox.loadNow()
            // At once, not when the earlier look comes back: nothing of the first account is left, and the second's own are read.
            assertNull(phone.inbox.answering)
            assertTrue(phone.opened.isEmpty)
            assertEquals(listOf("password"), phone.inbox.prompts.map { it.purpose })
        }
        // The first account's list arrives after the switch: it shows nothing.
        late.join()
        assertEquals(listOf("password"), phone.inbox.prompts.map { it.purpose })
        assertNull(phone.inbox.answering)
        assertTrue(phone.opened.isEmpty)
    }

    @Test
    fun aListForASessionThatIsNoLongerThePhonesShowsNothingEvenWithNoLookSince(): Unit = runBlocking {
        val two = TwoAccounts(this)
        val phone = two.phone
        two.hold.set(true)
        val late = launch { phone.inbox.loadNow() }
        two.letGoAfter {
            assertTrue("the look never went out", withContext(Dispatchers.IO) { two.held.await(10, TimeUnit.SECONDS) })
            // The session changed while the list was out, and nothing has looked since.
            two.switch()
        }
        late.join()
        assertTrue(phone.inbox.prompts.isEmpty())
        // The next look reads the second account's own.
        phone.inbox.loadNow()
        assertEquals(listOf("password"), phone.inbox.prompts.map { it.purpose })
        // Signed out: nothing is held, and nothing is asked.
        val looks = two.secondServer.calls.size
        phone.session = null
        phone.inbox.loadNow()
        assertTrue(phone.inbox.prompts.isEmpty())
        assertEquals(looks, two.secondServer.calls.size)
    }
}
