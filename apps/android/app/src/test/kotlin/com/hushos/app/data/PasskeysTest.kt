package com.hushos.app.data

import com.hushos.core.KeyAdded
import com.hushos.core.KeyAssertion
import com.hushos.core.KeyCreation
import com.hushos.core.KeyRegistration
import com.hushos.core.StepChallenge
import com.hushos.core.StepKey
import com.hushos.core.StepKeyRequest
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.keyAssertionRead
import com.hushos.core.keyRegistrationRead
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.Collections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A passkey or security key as the second step, and the default (docs/two-step-design.md 3, 12).
 * What these hold: the step opens on the account's usual way; a key is offered only with something to
 * ask it, and only on the server this app is linked to; nothing asks the key until the press that
 * sends its answer, and a key that did not answer sends nothing and costs nothing; an older server
 * never sees a field its schema refuses twice; and what goes out is, byte for byte in meaning, what a
 * browser sends (crates/hushos-core/fixtures/two-step-keys.json, which the core and the web hold to).
 */
class PasskeysTest {
    private val fixture = JSONObject(File("../../../crates/hushos-core/fixtures/two-step-keys.json").readText())
    private val token = fixture.getString("token")
    private val link = "hushos.com"

    /* A server whose answer depends on what it was asked, and what was asked of it. */
    private class Asked(val method: String, val path: String, val query: String?, val body: JSONObject)
    private val asked: MutableList<Asked> = Collections.synchronizedList(mutableListOf())
    @Volatile private var answers: (Asked) -> Pair<Int, String> = { 500 to "" }
    private var server: HttpServer? = null

    private fun serving(answers: (Asked) -> Pair<Int, String>): Shared.Session {
        this.answers = answers
        asked.clear()
        val running = server ?: HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { made ->
            made.createContext("/") { exchange ->
                val sent = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
                val request = Asked(exchange.requestMethod, exchange.requestURI.path, exchange.requestURI.query, runCatching { JSONObject(sent) }.getOrDefault(JSONObject()))
                asked += request
                val (code, text) = this.answers(request)
                val bytes = text.toByteArray()
                exchange.sendResponseHeaders(code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
                if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
                exchange.close()
            }
            made.start()
            server = made
        }
        return Shared.Session("http://127.0.0.1:${running.address.port}", "session-token", "user")
    }

    @org.junit.After
    fun stop() { server?.stop(0) }

    private fun refusal(message: String, code: String? = null) = JSONObject().put("message", message).apply { code?.let { put("code", it) } }.toString()

    /* The fixture's step as the server sends it, with the methods in `order` and whatever else a test changes. */
    private fun step(order: List<String> = listOf("webauthn", "totp", "backup", "phrase"), change: JSONObject.() -> Unit = {}): String =
        JSONObject(fixture.getJSONObject("step").toString()).put("methods", JSONArray(order)).apply(change).toString()

    /* Read as `two-step/challenge`'s reply is, by the core. */
    private fun creation(): KeyCreation =
        TwoStep.keyCreation(Auth.SessionReply(200, fixture.getJSONObject("options").toString(), fixture.getJSONObject("options")))!!

    private fun read(step: String): StepChallenge = (com.hushos.core.stepChallengeReplyRead(200u, step) as com.hushos.core.StepReply.Step).challenge

    private val handedAssertion: KeyAssertion get() = keyAssertionRead(fixture.getJSONObject("handedAssertion").toString())!!
    private val handedRegistration: KeyRegistration get() = keyRegistrationRead(fixture.getJSONObject("handedRegistration").toString())!!

    /* The phone's sheet, counting what it was asked. `cancelled`: the screen left while it was up. */
    private class Sheet(var assertion: KeyAssertion? = null, var registration: KeyRegistration? = null, val cancelled: Boolean = false) : KeySheet {
        val requests = mutableListOf<StepKeyRequest>()
        val creations = mutableListOf<KeyCreation>()
        override suspend fun assertion(request: StepKeyRequest): KeyAssertion? {
            requests += request
            if (cancelled) throw CancellationException("the screen left")
            return assertion
        }
        override suspend fun registration(creation: KeyCreation): KeyRegistration? {
            creations += creation
            if (cancelled) throw CancellationException("the screen left")
            return registration
        }
    }

    // Which server a key can be used for.

    @Test
    fun aPasskeyIsUsableOnlyOverHttpsOnTheHostTheAppIsLinkedTo() {
        assertTrue(Passkeys.usable("https://hushos.com", link))
        assertTrue(Passkeys.usable("https://hushos.com/", link))
        assertTrue(Passkeys.usable(" https://HushOS.com ", link))
        // A key is bound to the host: one that merely contains or ends in it is another server.
        for (other in listOf(
            "http://hushos.com", "https://drive.example.org", "https://hushos.com.evil.example", "https://evil.example/hushos.com",
            "https://hushos.com@evil.example", "https://app.hushos.com", "https://nothushos.com", "hushos.com", "", "not an address",
        )) assertFalse(other, Passkeys.usable(other, link))
        // Another port is another origin to the server, and the phone's sheet signs for the host alone; an address
        // that carries a user or a password is not the server's own. The default port, written out, is the same origin.
        assertTrue(Passkeys.usable("https://hushos.com:443", link))
        for (other in listOf("https://hushos.com:8443", "https://hushos.com:80", "https://user@hushos.com", "https://user:secret@hushos.com", "https://@hushos.com"))
            assertFalse(other, Passkeys.usable(other, link))
        // A debug build is linked to localhost over http: never a server a key can be used for, even though the host matches.
        assertFalse(Passkeys.usable("http://localhost:5173", "localhost"))
        assertFalse(Passkeys.usable("https://hushos.com", ""))
    }

    @Test
    fun aServerThatIsNotTheLinkHostIsNamedNoMethodsAndOffersNoAdd() {
        assertEquals(listOf("webauthn"), StepNames.named("https://hushos.com", link))
        assertEquals(emptyList<String>(), StepNames.named("https://drive.example.org", link))
        assertEquals(emptyList<String>(), StepNames.named("http://localhost:5173", "localhost"))
        val none = TwoStepStatus(on = false, methods = emptyList(), backupCodesLeft = 0, totpFrozen = false)
        assertTrue(none.canAddKey(passkeys = true))
        assertFalse(none.canAddKey(passkeys = false))
        // There, the list says where keys are added, and only there.
        assertEquals(listOf(StepWords.KEYS_IN_BROWSER), none.keyNotes(passkeys = false))
        assertEquals(emptyList<String>(), none.keyNotes(passkeys = true))
        // The settings still ask for the keys by name on every server: one added in a browser is listed, renamed and removed here.
        val session = serving { 200 to """{"on":true,"methods":[{"id":"k","kind":"webauthn","name":"Desk key","createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":null,"synced":false}],"backupCodesLeft":10,"totpFrozen":false,"defaultKind":"webauthn"}""" }
        assertFalse(Passkeys.usable(session.origin, link))
        val status = TwoStep.status(session)!!
        assertEquals("methods=webauthn", asked.single().query)
        assertEquals("/api/auth/two-step", asked.single().path)
        assertEquals("Desk key", status.keys.single().shownName)
        assertFalse(status.canAddKey(Passkeys.usable(session.origin, link)))
    }

    // What the step opens on and offers.

    @Test
    fun theStepOpensOnTheServersFirstMethodWhicheverKindIsTheDefault() {
        val keyFirst = read(step())
        assertEquals(listOf(StepMethod.WEBAUTHN, StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), keyFirst.methods)
        assertEquals(StepMethod.WEBAUTHN, SignInStep(keyFirst).shown)
        assertEquals("Use your passkey", SignInStep(keyFirst).button(busy = false))
        assertEquals(StepMethod.WEBAUTHN, StepUp(StepPurpose.PASSWORD).take(keyFirst).shown)
        // The app as the default: the same account, the other order. The screen opens on what the server put first, and
        // offers the rest in the server's order, never its own.
        val appFirst = read(step(listOf("totp", "webauthn", "backup", "phrase")))
        assertEquals(listOf(StepMethod.TOTP, StepMethod.WEBAUTHN, StepMethod.BACKUP, StepMethod.PHRASE), appFirst.methods)
        assertEquals(StepMethod.TOTP, SignInStep(appFirst).shown)
        assertEquals("Continue", SignInStep(appFirst).button(busy = false))
        assertEquals(appFirst.methods, SignInStep(appFirst).methods)
        assertEquals(StepMethod.TOTP, StepUp(StepPurpose.PASSWORD).take(appFirst).shown)
        assertEquals(appFirst.methods, StepUp(StepPurpose.PASSWORD).take(appFirst).methods)
        // The usual way can't be used here (the app paused for this sign-in): the backup code is first, and the screen opens on it.
        assertEquals(StepMethod.BACKUP, SignInStep(read(step(listOf("backup", "phrase")))).shown)
    }

    @Test
    fun aPasskeyIsNeverOfferedWithoutSomethingToAskItOrWhereThisPhoneCannotUseOne() {
        // Listed by the server with nothing to ask the key: the core leaves it out, and the rest keep their order.
        val bare = read(step { remove("webauthn") })
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), bare.offered(passkeys = true).methods)
        // The same rule held here, whatever read the step: a button that could only fail is never drawn.
        val whole = read(step())
        val unasked = whole.copy(keyRequest = null).offered(passkeys = true)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), unasked.methods)
        assertEquals(StepMethod.TOTP, SignInStep(unasked).shown)
        // A server this app is not linked to listed one all the same (it was named none): not offered, and nothing is kept to ask.
        val elsewhere = whole.offered(passkeys = false)
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), elsewhere.methods)
        assertNull(elsewhere.keyRequest)
        // With both, it is offered as the server sent it.
        assertEquals(whole, whole.offered(passkeys = true))
        // Through the route a change asks its step from, on a server that is not the link host.
        val session = serving { 200 to step() }
        val asked = TwoStep.challenge(session, StepPurpose.PASSWORD, StepAdverts.Memory(), passkeys = false)!!
        assertFalse(StepMethod.WEBAUTHN in asked.methods)
        assertTrue(StepMethod.WEBAUTHN in TwoStep.challenge(session, StepPurpose.PASSWORD, StepAdverts.Memory(), passkeys = true)!!.methods)
    }

    // The sheet, and the session it was asked under.

    @Test
    fun aKeyThatAnswersAfterASignOutIsNotHandedOn() {
        // The device is removed, or someone else signs in, while the system's sheet is up.
        for (after in listOf(null, "another-session")) {
            var current: String? = "the-session"
            val sheet = object : KeySheet {
                override suspend fun assertion(request: StepKeyRequest): KeyAssertion? = handedAssertion.also { current = after }
                override suspend fun registration(creation: KeyCreation): KeyRegistration? = handedRegistration.also { current = after }
            }
            val held = HeldSheet(sheet) { current }
            assertNull(runBlocking { held.registration(creation()) })
            current = "the-session"
            assertNull(runBlocking { held.assertion(read(step()).keyRequest!!) })
        }
        // Through the Add button: nothing is sent for the key, and the form says the key was not added.
        var current: String? = "the-session"
        val gone = object : KeySheet {
            override suspend fun assertion(request: StepKeyRequest): KeyAssertion? = null
            override suspend fun registration(creation: KeyCreation): KeyRegistration? = handedRegistration.also { current = null }
        }
        assertEquals(
            KeySetup.Pressed.Stay("Your passkey or security key wasn’t added. Try again."),
            runBlocking { KeySetup.pressed(creation(), "Desk key", HeldSheet(gone) { current }) },
        )
    }

    @Test
    fun underTheSameSessionOrNoneTheKeysAnswerIsHandedOn() {
        val sheet = Sheet(handedAssertion, handedRegistration)
        val held = HeldSheet(sheet) { "the-session" }
        assertEquals(handedRegistration, runBlocking { held.registration(creation()) })
        assertEquals(handedAssertion, runBlocking { held.assertion(read(step()).keyRequest!!) })
        // A sign-in's step has no session yet, before or after.
        assertEquals(handedAssertion, runBlocking { HeldSheet(sheet) { null }.assertion(read(step()).keyRequest!!) })
        // A screen that left is still a screen that left.
        assertThrows(CancellationException::class.java) {
            runBlocking { HeldSheet(Sheet(handedAssertion, cancelled = true)) { "the-session" }.assertion(read(step()).keyRequest!!) }
        }
    }

    // The press.

    @Test
    fun nothingAsksTheKeyUntilThePressAndAKeyThatDidNotAnswerSendsNothingAndKeepsTheStep() {
        val challenge = read(step())
        val sheet = Sheet()
        // The step appears, says its line and its button, and the person looks at another way and comes back: no sheet.
        var step = SignInStep(challenge)
        assertEquals(StepMethod.WEBAUTHN, step.shown)
        step.button(busy = false)
        StepNote.of(challenge, passkeys = true, change = false)
        step = step.typed(step.draft.copy(method = StepMethod.TOTP)).let { it.typed(it.draft.copy(method = StepMethod.WEBAUTHN)) }
        assertNull(step.draft.problem(StepMethod.WEBAUTHN))
        assertTrue("the sheet was asked before any press", sheet.requests.isEmpty())

        // The press asks the key this step's own challenge and the account's keys. The sheet is closed: there is no
        // answer to send, and the step is as it was, with why.
        val closed = runBlocking { step.pressed(sheet) }
        assertEquals(listOf(challenge.keyRequest), sheet.requests)
        assertEquals(SignInStep.Pressed.Stay(step.copy(fieldError = StepWords.PASSKEY_UNUSED)), closed)
        val stayed = (closed as SignInStep.Pressed.Stay).step
        assertEquals(challenge.methods, stayed.methods)
        assertEquals(StepMethod.WEBAUTHN, stayed.shown)
        assertEquals("Your passkey or security key wasn’t used. Try again, or use another way.", stayed.fieldError)

        // Pressed again, the key answers: its answer is what goes, under this step's token.
        sheet.assertion = handedAssertion
        val sent = runBlocking { stayed.pressed(sheet) } as SignInStep.Pressed.Send
        assertEquals(2, sheet.requests.size)
        assertEquals(StepAnswer(token, StepProof.Webauthn(handedAssertion)), sent.answer)
        assertEquals(StepMethod.WEBAUTHN, sent.answer.method)
        assertEquals("", sent.step.fieldError)

        // The screen left while the sheet was up (a rotation): the press ends there, with nothing to send.
        assertThrows(CancellationException::class.java) { runBlocking { step.pressed(Sheet(handedAssertion, cancelled = true)) } }
    }

    @Test
    fun aCodeIsNeverSentThroughTheSheetAndALostReplySendsTheSameAnswerWithoutAskingTheKeyAgain() {
        val challenge = read(step(listOf("totp", "webauthn", "backup", "phrase")))
        val sheet = Sheet(handedAssertion)
        val typing = SignInStep(challenge)
        // A code that is not ready is the field's own complaint; a ready one goes. Neither opens the sheet.
        assertEquals("Enter the 6-digit code from your authenticator app.", (runBlocking { typing.pressed(sheet) } as SignInStep.Pressed.Stay).step.fieldError)
        val code = runBlocking { typing.typed(typing.draft.copy(totp = "123 456")).pressed(sheet) } as SignInStep.Pressed.Send
        assertEquals(StepProof.Totp("123 456"), code.answer.proof)
        assertTrue(sheet.requests.isEmpty())
        // Use another way: the key. Its reply is lost: the same answer goes again, and the key is not asked a second time.
        val keyed = typing.typed(typing.draft.copy(method = StepMethod.WEBAUTHN))
        val first = runBlocking { keyed.pressed(sheet) } as SignInStep.Pressed.Send
        val lost = first.step.after(StepOutcome.Retry(StepWords.LOST_STEP), first.answer)
        assertEquals("Try again", lost.button(busy = false))
        assertEquals(StepWords.LOST_STEP, lost.notice)
        val again = runBlocking { lost.pressed(sheet) } as SignInStep.Pressed.Send
        assertEquals(first.answer, again.answer)
        assertEquals(1, sheet.requests.size)
        // The server's own refusal of the key stays on the step, in its words, with every way still offered.
        val said = "That passkey or security key didn’t work. Try again, or use another way."
        val wrong = first.step.after(StepOutcome.after(StepRefused(StepRefusal.WRONG, said), first.step.methods, StepMethod.WEBAUTHN), first.answer)
        assertEquals(said, wrong.fieldError)
        assertEquals(challenge.methods, wrong.methods)
        assertEquals(StepMethod.WEBAUTHN, wrong.shown)
        assertNull(wrong.lost)
    }

    @Test
    fun insideAChangeTheKeyIsAskedByTheChangesOwnPressAndOneThatDidNotAnswerSendsNoChange() {
        val challenge = read(step())
        val sheet = Sheet()
        // The form opens with the step's fields: nothing is asked of the key.
        val asked = StepUp(StepPurpose.DELETE).take(challenge)
        assertEquals(StepMethod.WEBAUTHN, asked.shown)
        assertEquals("", asked.problem)
        assertTrue(sheet.requests.isEmpty())
        // The change's button is pressed and the sheet is closed: no answer for the change to carry, the step as it was, and why.
        val unready = runBlocking { asked.prove(sheet) } as StepUp.Proof.Unready
        assertEquals(listOf(challenge.keyRequest), sheet.requests)
        assertEquals(asked.copy(error = StepWords.PASSKEY_UNUSED), unready.step)
        assertEquals(StepWords.PASSKEY_UNUSED, unready.step.problem)
        assertEquals(challenge, unready.step.challenge)
        // Answered, the change carries the key's answer.
        sheet.assertion = handedAssertion
        val ready = runBlocking { unready.step.prove(sheet) } as StepUp.Proof.Ready
        assertEquals(StepProof.Webauthn(handedAssertion), ready.answer.proof)
        assertEquals(token, ready.answer.token)
        // A code typed for the change is checked before anything else, and never opens the sheet.
        val typed = asked.typed(asked.draft.copy(method = StepMethod.TOTP, totp = "12"))
        assertTrue((runBlocking { typed.prove(sheet) } as StepUp.Proof.Unready).step.tried)
        assertEquals(2, sheet.requests.size)
        assertThrows(CancellationException::class.java) { runBlocking { asked.prove(Sheet(handedAssertion, cancelled = true)) } }
    }

    // What goes out, against the fixture the core and the web hold to.

    @Test
    fun theKeysAnswerIsCutToWhatTheServerChecksAndGoesToTheStepRouteAsABrowsersDoes() {
        val handed = fixture.getJSONObject("handedAssertion")
        val assertion = handedAssertion
        // The four fields, as the key gave them: base64url without padding, nothing re-encoded on the way.
        assertEquals(handed.getString("rawId"), assertion.credentialId)
        assertEquals(handed.getJSONObject("response").getString("clientDataJSON"), assertion.clientDataJson)
        assertEquals(handed.getJSONObject("response").getString("authenticatorData"), assertion.authenticatorData)
        assertEquals(handed.getJSONObject("response").getString("signature"), assertion.signature)
        val base64url = Regex("^[A-Za-z0-9_-]+$")
        for (field in listOf(assertion.credentialId, assertion.clientDataJson, assertion.authenticatorData, assertion.signature)) assertTrue(field, base64url.matches(field))
        // A reply without the key's answer in it is not one: the caller says the key wasn't used.
        assertNull(keyAssertionRead("""{"id":"a2V5","rawId":"a2V5","type":"public-key","response":{}}"""))
        assertNull(keyAssertionRead("not json"))

        val answer = StepAnswer(token, StepProof.Webauthn(assertion))
        assertTrue(answer.json().toString(), sameJson(fixture.getJSONObject("answer"), answer.json()))
        // At sign-in it goes to the step's own route, whole. The reply here is no session: only what was sent is looked at.
        val session = serving { 401 to refusal("That passkey or security key didn’t work. Try again, or use another way.", "step-wrong") }
        val refused = assertThrows(StepRefused::class.java) { Auth.answerStepAt(session.origin, token, answer.proof) }
        assertEquals(StepRefusal.WRONG, refused.refusal)
        assertEquals("/api/auth/login/two-step", asked.single().path)
        assertTrue(asked.single().body.toString(), sameJson(fixture.getJSONObject("answer"), asked.single().body))
    }

    @Test
    fun aNewKeysRegistrationGoesOutAsABrowsersDoesAndOnlyTheServersOwnAnswerSaysItWasAdded() {
        val handed = fixture.getJSONObject("handedRegistration")
        val registration = handedRegistration
        assertEquals(handed.getString("rawId"), registration.credentialId)
        assertEquals(handed.getJSONObject("response").getString("clientDataJSON"), registration.clientDataJson)
        assertEquals(handed.getJSONObject("response").getString("attestationObject"), registration.attestationObject)
        assertEquals(listOf("internal", "hybrid"), registration.transports)
        assertNull(keyRegistrationRead("{}"))

        val codes = (1..10).map { "7KQ2M-9XD4$it" }
        val method = JSONObject().put("id", "f1").put("kind", "webauthn").put("name", "Desk key").put("createdAt", "2026-11-14T10:00:00.000Z").put("lastUsedAt", JSONObject.NULL).put("synced", false)
        var session = serving { 200 to JSONObject().put("method", method).put("backupCodes", JSONArray(codes)).toString() }
        val registrationToken = fixture.getJSONObject("options").getString("registrationToken")
        val added = TwoStep.addKey(session, registrationToken, fixture.getString("registrationName"), registration)
        assertEquals(KeyAdded("f1", "Desk key", false, codes), added)
        val sent = asked.single()
        assertEquals("POST", sent.method)
        assertEquals("/api/auth/two-step/keys", sent.path)
        assertTrue(sent.body.toString(), sameJson(fixture.getJSONObject("registrationBody"), sent.body))
        // No name given: none is sent, and the server names the key.
        TwoStep.addKey(session, registrationToken, null, registration)
        assertFalse(asked.last().body.has("name"))

        // The server's refusals come in its own words, and each is one the setup ends on.
        for ((status, said, code) in listOf(
            Triple(409, "You have ten passkeys and security keys, the most an account can have.", "limit"),
            Triple(409, "That passkey or security key is already added.", "exists"),
            Triple(400, "That passkey or security key couldn’t be added. Start again.", "key-refused"),
            Triple(404, "This setup timed out. Start again.", null),
        )) {
            session = serving { status to refusal(said, code) }
            val refused = assertThrows("$status $code", KeyRefused::class.java) { TwoStep.addKey(session, registrationToken, null, registration) }
            assertEquals(said, refused.message)
        }
        session = serving { 401 to refusal("Sign in again.") }
        assertThrows(NotAuthenticated::class.java) { TwoStep.addKey(session, registrationToken, null, registration) }
        // Anything else with a 200, or a gateway's 502, is not the server's answer: the key may have been added or not.
        for ((status, body) in listOf(200 to """{"success":true}""", 200 to "<html>", 200 to JSONObject().put("method", method).put("backupCodes", JSONArray()).toString(), 502 to refusal("Bad gateway"))) {
            session = serving { status to body }
            val lost = assertThrows("$status $body", LostReply::class.java) { TwoStep.addKey(session, registrationToken, null, registration) }
            assertEquals("The server’s answer didn’t arrive, so HushOS can’t tell whether your passkey or security key was added. Check before you try again.", lost.message)
        }
    }

    @Test
    fun whatAKeyIsAskedWhenItIsAddedIsReadWholeOrNotAtAll() {
        val options = fixture.getJSONObject("options")
        fun reply(status: Int, body: String) = Auth.SessionReply(status, body, runCatching { JSONObject(body) }.getOrDefault(JSONObject()))
        val creation = TwoStep.keyCreation(reply(200, options.toString()))
        val asked = options.getJSONObject("options")
        assertEquals(options.getString("registrationToken"), creation.registrationToken)
        assertEquals(asked.getString("challenge"), creation.challenge)
        assertEquals("hushos.com", creation.rpId)
        assertEquals(asked.getJSONObject("user").getString("id"), creation.userId)
        assertEquals(listOf(-8L, -7L, -257L), creation.algorithms)
        assertEquals(listOf(StepKey("c2VjdXJpdHkta2V5LW9uZQ", listOf("usb", "nfc"))), creation.exclude)
        // Options short of what the server always sets, or something else with a 200: the setup did not start.
        assertEquals(StepWords.LOST_SETUP, assertThrows(LostReply::class.java) { TwoStep.keyCreation(reply(200, "{}")) }.message)
        assertThrows(LostReply::class.java) { TwoStep.keyCreation(reply(200, JSONObject(options.toString()).apply { getJSONObject("options").remove("challenge") }.toString())) }
        // The step's refusal is the step's, with its code; the route's own is the form's, in the server's words.
        val wrong = assertThrows(StepRefused::class.java) { TwoStep.keyCreation(reply(401, refusal("That code didn’t work.", "step-wrong"))) }
        assertEquals(StepRefusal.WRONG, wrong.refusal)
        val limit = assertThrows(AuthFailure::class.java) { TwoStep.keyCreation(reply(409, refusal("You have ten passkeys and security keys, the most an account can have.", "limit"))) }
        assertFalse(limit is StepRefused)
        assertEquals("You have ten passkeys and security keys, the most an account can have.", limit.message)
    }

    // `twoStepMethods`: only to a server that reads it.

    private val device = JSONObject().put("id", "d").put("signature", "s")

    /* `login/finish` against a server that answers each request with the next of `statuses`; what it was sent. One request too many fails. */
    private fun finishing(memory: StepAdverts, startText: String, passkeys: Boolean, vararg statuses: Int): Pair<List<JSONObject>, Int> {
        val sent = mutableListOf<JSONObject>()
        val left = statuses.toMutableList()
        val reply = Auth.finishNamed(memory, "https://hushos.com", startText, passkeys, { Auth.finishBody("attempt", "ke3", device, it) }) { body ->
            sent += JSONObject(body.toString())
            Auth.RawReply(left.removeAt(0), "", JSONObject(), null, null)
        }
        assertTrue("fewer requests than answers: $left", left.isEmpty())
        return sent to reply.status
    }

    @Test
    fun signInNamesItsMethodsOnlyToAServerThatSaidItReadsThem() {
        val advertising = """{"attemptToken":"attempt","loginResponse":"ke2","twoStepMethods":true}"""
        val silent = """{"attemptToken":"attempt","loginResponse":"ke2"}"""
        val memory = StepAdverts.Memory()
        // Advertised: the field goes, beside `twoStep: 1`, which never changes.
        var (sent, status) = finishing(memory, advertising, true, 200)
        assertEquals(200, status)
        assertEquals(listOf("webauthn"), sent.single().getJSONArray("twoStepMethods").let { list -> (0 until list.length()).map(list::getString) })
        assertEquals(1, sent.single().get("twoStep"))
        assertEquals(true, memory.read("https://hushos.com"))
        // A phone that can't use a key for this server says so with an empty list: the server then never lists one.
        sent = finishing(memory, advertising, false, 200).first
        assertEquals(0, sent.single().getJSONArray("twoStepMethods").length())
        // A release from before passkeys says nothing, and never sees the field.
        sent = finishing(memory, silent, true, 200).first
        assertFalse(sent.single().has("twoStepMethods"))
        assertEquals(1, sent.single().get("twoStep"))
        assertEquals(false, memory.read("https://hushos.com"))
        // Saying it as text, or as anything but `true`, is not saying it.
        assertFalse(finishing(memory, """{"attemptToken":"attempt","twoStepMethods":"true"}""", true, 200).first.single().has("twoStepMethods"))
    }

    @Test
    fun aSchemasRefusalAtSignInIsAskedOnceMoreWithoutTheFieldOnTheSameAttempt() {
        val advertising = """{"attemptToken":"attempt","loginResponse":"ke2","twoStepMethods":true}"""
        for (refused in listOf(422, 400)) {
            val memory = StepAdverts.Memory()
            val (sent, status) = finishing(memory, advertising, true, refused, 200)
            assertEquals("$refused", 200, status)
            assertEquals(2, sent.size)
            assertTrue(sent[0].has("twoStepMethods"))
            // The same request but for the field: the same attempt, the same proof, the same device.
            assertTrue(sent[1].toString(), sameJson(JSONObject(sent[0].toString()).apply { remove("twoStepMethods") }, sent[1]))
            assertEquals("attempt", sent[1].getString("attemptToken"))
            assertEquals("d", sent[1].getJSONObject("device").getString("id"))
            // This sign-in's own `login/start` said it reads the field (a rolling update): that still stands for the session's changes.
            assertEquals(true, memory.read("https://hushos.com"))
        }
        // Once: a server that refuses the request without the field too gets no third one.
        assertEquals(2 to 422, finishing(StepAdverts.Memory(), advertising, true, 422, 422).let { it.first.size to it.second })
        // A wrong password, the limiter and a server error are answers, not a schema's refusal: nothing is sent again.
        for (answer in listOf(401, 409, 429, 500)) assertEquals("$answer", 1, finishing(StepAdverts.Memory(), advertising, true, answer).first.size)
        // A server that never advertised it is never sent the field, so there is nothing to ask again without.
        assertEquals(1, finishing(StepAdverts.Memory(), """{"attemptToken":"attempt"}""", true, 422).first.size)
    }

    @Test
    fun aSessionsChangesNameMethodsByWhatItsServerLastSaidAndRememberARefusal() {
        val named: (Asked) -> Boolean = { it.body.has("twoStepMethods") }
        // Never heard (a session from before this version): the field is sent once. This server reads it, and nothing is concluded.
        var memory = StepAdverts.Memory()
        var session = serving { 200 to step(listOf("totp", "backup", "phrase")) { remove("webauthn") } }
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), TwoStep.challenge(session, StepPurpose.PASSWORD, memory)?.methods)
        assertEquals(listOf(true), asked.map(named))
        assertEquals("password", asked.single().body.getString("purpose"))
        assertNull(memory.read(session.origin))

        // Never heard, and this server's schema refuses it: asked once more without, and remembered as one that does not read it.
        for (refused in listOf(422, 400)) {
            memory = StepAdverts.Memory()
            session = serving { if (named(it)) refused to refusal("Unknown field.") else 200 to step(listOf("totp", "backup", "phrase")) { remove("webauthn") } }
            assertEquals(token, TwoStep.challenge(session, StepPurpose.MASTER_KEY, memory)?.token)
            assertEquals(listOf(true, false), asked.map(named))
            assertEquals("master-key", asked.last().body.getString("purpose"))
            assertEquals(false, memory.read(session.origin))
            // From then on the field is not sent at all: one request, not two, for every later change.
            TwoStep.challenge(session, StepPurpose.DELETE, memory)
            assertEquals(listOf(true, false, false), asked.map(named))
        }

        // "Does not read it" is believed for a day. The server is updated meanwhile: a day on, the same session's
        // next change names its methods again, and is offered its key. Believed for ever, it never would be.
        var clock = 1_000_000_000_000L
        memory = StepAdverts.Memory { clock }
        session = serving { if (named(it)) 400 to refusal("Unknown field.") else 200 to step(listOf("totp", "backup", "phrase")) { remove("webauthn") } }
        TwoStep.challenge(session, StepPurpose.PASSWORD, memory)
        assertEquals(false, memory.read(session.origin))
        clock += StepAdverts.NO_MS - 1
        assertEquals(false, memory.read(session.origin))
        clock += 1
        assertNull(memory.read(session.origin))
        session = serving { 200 to step(listOf("webauthn", "backup", "phrase")) }
        TwoStep.challenge(session, StepPurpose.PASSWORD, memory, passkeys = true)
        assertEquals(listOf(true), asked.map(named))
        // A clock set back does not stretch the day: a time from the future is not believed.
        memory = StepAdverts.Memory { clock }.apply { write(session.origin, false) }
        clock -= 60_000
        assertNull(memory.read(session.origin))

        // Advertised at the last sign-in, and since rolled back: the same, and the advert is taken back.
        memory = StepAdverts.Memory().apply { write(session.origin, true) }
        session = serving { if (named(it)) 422 to refusal("Unknown field.") else 200 to step(listOf("totp", "backup", "phrase")) { remove("webauthn") } }
        TwoStep.challenge(session, StepPurpose.PASSWORD, memory)
        assertEquals(listOf(true, false), asked.map(named))
        assertEquals(false, memory.read(session.origin))

        // Not advertised: never sent.
        memory = StepAdverts.Memory().apply { write(session.origin, false) }
        session = serving { 200 to step(listOf("totp", "backup", "phrase")) { remove("webauthn") } }
        TwoStep.challenge(session, StepPurpose.PASSWORD, memory)
        assertEquals(listOf(false), asked.map(named))

        // Refused with and without the field: the field was not what the server minded, so nothing is remembered about it.
        memory = StepAdverts.Memory()
        session = serving { 400 to refusal("That request can’t be read.") }
        assertThrows(StepRefused::class.java) { TwoStep.challenge(session, StepPurpose.PASSWORD, memory) }
        assertEquals(2, asked.size)
        assertNull(memory.read(session.origin))
        // An account without the step (409) is an answer, not a refusal of the field.
        session = serving { 409 to refusal("Two-step sign-in is off for this account.") }
        assertNull(TwoStep.challenge(session, StepPurpose.PASSWORD, memory))
        assertEquals(1, asked.size)
        assertNull(memory.read(session.origin))

        // Kept per server, however its address was typed: one server's answer says nothing of another's.
        memory = StepAdverts.Memory().apply { write("https://HushOS.com/", false) }
        assertEquals(false, memory.read("https://hushos.com"))
        assertNull(memory.read("https://drive.example.org"))
    }

    // The one line above the fields.

    @Test
    fun theStepSaysToUpdateOrThatTheUsualWayIsOutNeverBothAndNeverWhy() {
        fun note(withheld: Boolean, unavailable: Boolean, passkeys: Boolean, change: Boolean = false) =
            StepNote.of(read(step(listOf("backup", "phrase")) { remove("webauthn"); put("withheld", withheld); put("defaultUnavailable", unavailable) }), passkeys, change)
        // Something was left out though this phone named every kind it knows: a newer HushOS has it. Said alone, even when the usual way is out too.
        assertEquals("Update HushOS to use your passkey or another device.", note(withheld = true, unavailable = false, passkeys = true))
        assertEquals("Update HushOS to use your passkey or another device.", note(withheld = true, unavailable = true, passkeys = true))
        assertEquals("Update HushOS to use your passkey or another device.", note(withheld = true, unavailable = true, passkeys = true, change = true))
        // This phone held the passkey back itself (a server it is not linked to): updating would change nothing, so only the usual-way line.
        assertEquals("Your usual way isn’t available for this sign-in.", note(withheld = true, unavailable = true, passkeys = false))
        assertEquals("", note(withheld = true, unavailable = false, passkeys = false))
        assertEquals("Your usual way isn’t available for this sign-in.", note(withheld = false, unavailable = true, passkeys = true))
        assertEquals("Your usual way isn’t available for this change.", note(withheld = false, unavailable = true, passkeys = true, change = true))
        assertEquals("Your usual way isn’t available for this change.", note(withheld = false, unavailable = true, passkeys = false, change = true))
        assertEquals("", note(withheld = false, unavailable = false, passkeys = true))
        // Every case is one line or none.
        val lines = setOf(StepNote.UPDATE, StepNote.USUAL_SIGN_IN, StepNote.USUAL_CHANGE, "")
        for (withheld in listOf(true, false)) for (unavailable in listOf(true, false)) for (passkeys in listOf(true, false)) for (change in listOf(true, false))
            assertTrue(note(withheld, unavailable, passkeys, change) in lines)
    }

    // After a refusal.

    @Test
    fun aSpentCodeBudgetLeavesThePasskeyAndThePhraseAndEachOtherRefusalTakesOnlyItsOwn() {
        val all = listOf(StepMethod.WEBAUTHN, StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE)
        val limited = StepRefused(StepRefusal.LIMITED, "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.")
        // The budget is the codes': a key and the phrase have none, and stay.
        assertEquals(StepOutcome.Again(limited.message!!, false, listOf(StepMethod.WEBAUTHN, StepMethod.PHRASE)), StepOutcome.after(limited, all, StepMethod.TOTP))
        val change = StepUp(StepPurpose.PASSWORD).take(read(step())).let { it.typed(it.draft.copy(method = StepMethod.BACKUP)) }
        val (next, narrowed) = change.failed(limited)
        assertEquals(StepUp.Next.AGAIN, next)
        assertEquals(listOf(StepMethod.WEBAUTHN, StepMethod.PHRASE), narrowed.methods)
        // What is shown moves with what is left: the code field is gone, and the key is the way shown.
        assertEquals(StepMethod.WEBAUTHN, narrowed.shown)
        val signIn = SignInStep(read(step(listOf("totp", "webauthn", "backup", "phrase"))))
        val after = signIn.after(StepOutcome.after(limited, signIn.methods, StepMethod.TOTP), StepAnswer(token, StepProof.Totp("123456")))
        assertEquals(listOf(StepMethod.WEBAUTHN, StepMethod.PHRASE), after.methods)
        assertEquals(StepMethod.WEBAUTHN, after.shown)
        assertEquals(limited.message, after.notice)
        // A paused app takes only the app; a method the server can't check, only the one tried.
        assertEquals(listOf(StepMethod.WEBAUTHN, StepMethod.BACKUP, StepMethod.PHRASE), StepOutcome.left(all, StepRefusal.FROZEN, StepMethod.TOTP))
        assertEquals(listOf(StepMethod.TOTP, StepMethod.BACKUP, StepMethod.PHRASE), StepOutcome.left(all, StepRefusal.UNAVAILABLE, StepMethod.WEBAUTHN))
        assertEquals(listOf(StepMethod.WEBAUTHN, StepMethod.TOTP, StepMethod.PHRASE), StepOutcome.left(all, StepRefusal.UNAVAILABLE, StepMethod.BACKUP))
        // A wrong answer from the key, and a key that was never used, take nothing away.
        assertEquals(all, StepOutcome.left(all, StepRefusal.WRONG, StepMethod.WEBAUTHN))
        assertEquals(StepOutcome.Again(StepWords.PASSKEY_UNUSED, true, all), StepOutcome.after(KeyUnused(), all, StepMethod.WEBAUTHN))
    }

    // Settings.

    private fun key(id: String, name: String? = "Key $id", synced: Boolean = false, used: String? = null) =
        TwoStepStatus.Method(id, "webauthn", name, "2026-11-14T09:30:00.000Z", used, synced)
    private val app = TwoStepStatus.Method("a", "totp", null, "2026-11-12T09:30:00.000Z", null)
    private fun status(vararg methods: TwoStepStatus.Method, default: String? = null) = TwoStepStatus(methods.isNotEmpty(), methods.toList(), 10, false, default)

    @Test
    fun theSettingsReadTheKeysAndWhichKindIsAskedFirst() {
        val served = JSONObject("""{"on":true,"methods":[
            {"id":"k1","kind":"webauthn","name":"Desk key","createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":"2026-11-14T18:00:00.000Z","synced":false},
            {"id":"k2","kind":"webauthn","name":"Phone","createdAt":"2026-11-14T09:40:00.000Z","lastUsedAt":null,"synced":true},
            {"id":"a","kind":"totp","name":null,"createdAt":"2026-11-12T09:30:00.000Z","lastUsedAt":null,"synced":false}
        ],"backupCodesLeft":9,"totpFrozen":false,"defaultKind":"webauthn"}""")
        val read = TwoStepStatus.from(served)!!
        assertEquals(listOf("k1", "k2"), read.keys.map { it.id })
        assertEquals(listOf(false, true), read.keys.map { it.synced })
        assertEquals("a", read.app?.id)
        assertEquals("webauthn", read.defaultKind)
        // An older server sends no default and no `synced`: read as none, never as a guess.
        val older = TwoStepStatus.from(JSONObject("""{"on":true,"methods":[{"id":"a","kind":"totp","name":null,"createdAt":null,"lastUsedAt":null}],"backupCodesLeft":9,"totpFrozen":false}"""))!!
        assertNull(older.defaultKind)
        assertFalse(older.app!!.synced)
        assertNull(TwoStepStatus.from(JSONObject(served.toString()).put("defaultKind", JSONObject.NULL))!!.defaultKind)

        // The line under a key's name: where it lives only for a synced one, "Last used" only when it was.
        val day: (String?) -> String? = { iso -> iso?.let { "${it.substring(8, 10)} Nov" } }
        assertEquals("Added 14 Nov · Last used 14 Nov", read.keys[0].detail(day))
        assertEquals("Saved in a password manager · Added 14 Nov", read.keys[1].detail(day))
        // The app's row says one fact: last used, or added when it never was, or nothing without a date.
        assertEquals("Last used 14 Nov", read.keys[0].latest(day))
        assertEquals("Added 14 Nov", read.keys[1].latest(day))
        assertEquals("", older.app!!.latest(day))
        assertEquals("Saved in a password manager · Added 14 Nov · Last used 15 Nov", key("k", synced = true, used = "2026-11-15T08:00:00.000Z").detail(day))
        assertEquals("Security key", key("k", name = null).shownName)
    }

    @Test
    fun theDefaultBadgeFollowsTheServersDefaultKindAndIsAChoiceOnlyWithBothKinds() {
        val keyDefault = status(key("k"), app, default = "webauthn")
        assertTrue(keyDefault.isDefault("webauthn"))
        assertFalse(keyDefault.isDefault("totp"))
        assertTrue(keyDefault.canMakeDefault("totp"))
        assertFalse(keyDefault.canMakeDefault("webauthn"))
        val appDefault = status(key("k"), app, default = "totp")
        assertTrue(appDefault.isDefault("totp"))
        assertFalse(appDefault.isDefault("webauthn"))
        assertTrue(appDefault.canMakeDefault("webauthn"))
        assertFalse(appDefault.canMakeDefault("totp"))
        // One kind only: nothing to choose between, so neither a badge nor a button, whatever the default says.
        for (one in listOf(status(key("k"), key("l"), default = "webauthn"), status(app, default = "totp"), status(default = null)))
            for (kind in listOf("webauthn", "totp")) {
                assertFalse(one.isDefault(kind))
                assertFalse(one.canMakeDefault(kind))
            }
        // What changing it says, by the kind it moved to.
        assertEquals("Passkey or security key is now the default.", TwoStepStatus.defaultSaid("webauthn"))
        assertEquals("Authenticator app is now the default.", TwoStepStatus.defaultSaid("totp"))
    }

    @Test
    fun theLastMethodSaysTurnOffAndAnyOtherSaysRemove() {
        val both = status(key("k"), app)
        assertEquals("Remove", both.removeWords(both.keys.single()))
        assertEquals("Remove", both.removeWords(app))
        assertFalse(both.last(app))
        val two = status(key("k"), key("l"))
        assertEquals(listOf("Remove", "Remove"), two.keys.map(two::removeWords))
        // The account's only method is not removed: turning it off is turning the step off, whichever kind it is.
        val onlyKey = status(key("k"))
        assertEquals("Turn off", onlyKey.removeWords(onlyKey.keys.single()))
        assertTrue(onlyKey.last(onlyKey.keys.single()))
        assertEquals("Turn off", status(app).removeWords(app))
    }

    @Test
    fun theOnlyNotesUnderTheKeysSayWhyAddIsNotThere() {
        val ten = "You have ten, the most an account can have."
        // Add is there: nothing is said, with one key or several, synced or not, beside an app or not.
        assertEquals(emptyList<String>(), status().keyNotes(true))
        assertEquals(emptyList<String>(), status(app).keyNotes(true))
        assertEquals(emptyList<String>(), status(key("k")).keyNotes(true))
        assertEquals(emptyList<String>(), status(key("k", synced = true)).keyNotes(true))
        assertEquals(emptyList<String>(), status(key("k"), key("l", synced = true), app).keyNotes(true))
        val full = status(*(1..10).map { key("k$it") }.toTypedArray())
        assertEquals(listOf(ten), full.keyNotes(true))
        assertEquals(listOf(ten, StepWords.KEYS_IN_BROWSER), full.keyNotes(false))
        // The Add row adds another once there is a key: it is never read as acting on the key above it.
        assertEquals("Add", status().addKeyWords)
        assertEquals("Add", status(app).addKeyWords)
        assertEquals("Add another", status(key("k")).addKeyWords)
        assertEquals("Add another", status(key("k"), key("l"), app).addKeyWords)
        // Ten is the limit: no Add from there, on any server; nine still has one.
        assertFalse(full.canAddKey(passkeys = true))
        assertTrue(status(*(1..9).map { key("k$it") }.toTypedArray()).canAddKey(passkeys = true))
        // A server this phone can't add keys for says so last, beside whatever else is true.
        assertEquals(listOf(StepWords.KEYS_IN_BROWSER), status(key("k")).keyNotes(false))
        assertEquals("Passkeys and security keys are added in a browser on this server.", StepWords.KEYS_IN_BROWSER)
    }

    @Test
    fun aKeyIsRenamedAndTheDefaultChangedWithoutAPasswordAndTheServersRefusalIsSaidAsSent() {
        var session = serving { 200 to """{"method":{"id":"k1","kind":"webauthn","name":"Travel key","createdAt":"2026-11-14T09:30:00.000Z","lastUsedAt":null,"synced":false}}""" }
        assertEquals("Travel key", TwoStep.renameMethod(session, "k1", "  Travel key ").name)
        assertEquals("PUT", asked.single().method)
        assertEquals("/api/auth/two-step/methods/k1", asked.single().path)
        assertTrue(sameJson(JSONObject().put("name", "Travel key"), asked.single().body))
        session = serving { 400 to refusal("Use a name without line breaks.") }
        assertEquals("Use a name without line breaks.", assertThrows(AuthFailure::class.java) { TwoStep.renameMethod(session, "k1", "a\nb") }.message)

        session = serving { 200 to """{"defaultKind":"totp"}""" }
        assertEquals("totp", TwoStep.makeDefault(session, "totp"))
        assertEquals("PUT", asked.single().method)
        assertEquals("/api/auth/two-step/default", asked.single().path)
        assertTrue(sameJson(JSONObject().put("kind", "totp"), asked.single().body))
        // A session that never passed the step (403), and a kind the account no longer has (404): the server's words.
        for ((status, said) in listOf(403 to "Sign in again with your second step to change this.", 404 to "This account has no authenticator app.")) {
            session = serving { status to refusal(said) }
            assertEquals(said, assertThrows(AuthFailure::class.java) { TwoStep.makeDefault(session, "totp") }.message)
        }
        // A 200 that does not say which kind is now first says nothing.
        session = serving { 200 to "{}" }
        assertThrows(LostReply::class.java) { TwoStep.makeDefault(session, "webauthn") }
    }

    // Adding a key.

    @Test
    fun addingAKeyAsksTheSheetOnlyOnItsPressAndAClosedSheetSendsNothing() {
        val creation = TwoStep.keyCreation(Auth.SessionReply(200, fixture.getJSONObject("options").toString(), fixture.getJSONObject("options")))
        val sheet = Sheet()
        // A name too long is said before the phone is asked anything.
        assertEquals(KeySetup.Pressed.Stay("Use no more than 40 characters."), runBlocking { KeySetup.pressed(creation, "k".repeat(41), sheet) })
        assertTrue(sheet.creations.isEmpty())
        // The sheet is closed: nothing to send, and the same setup stands to press again.
        assertEquals(KeySetup.Pressed.Stay("Your passkey or security key wasn’t added. Try again."), runBlocking { KeySetup.pressed(creation, "", sheet) })
        assertEquals(listOf(creation), sheet.creations)
        // A key answers: its registration goes with the name as typed, trimmed, or none.
        sheet.registration = handedRegistration
        assertEquals(KeySetup.Pressed.Send(handedRegistration, "Desk key"), runBlocking { KeySetup.pressed(creation, "  Desk key ", sheet) })
        assertEquals(KeySetup.Pressed.Send(handedRegistration, null), runBlocking { KeySetup.pressed(creation, "   ", sheet) })
        assertThrows(CancellationException::class.java) { runBlocking { KeySetup.pressed(creation, "", Sheet(cancelled = true)) } }
        // A name is counted as a person counts it: forty emoji are forty characters, not eighty.
        assertNull(KeyName.problem("🔑".repeat(40)))
        assertEquals("Use no more than 40 characters.", KeyName.problem("🔑".repeat(41)))
        assertEquals("Enter a name.", KeyName.problem("   "))
        assertNull(KeyName.problem("Desk key"))
    }

    @Test
    fun whatAddingAKeyMadeIsKeptAndAnythingTheServerAnsweredEndsTheSetup() {
        val creation = TwoStep.keyCreation(Auth.SessionReply(200, fixture.getJSONObject("options").toString(), fixture.getJSONObject("options")))
        val started = TwoStepFlow().started().keyStarted(creation)
        assertEquals(creation, started.creation)
        assertFalse(started.pending)
        val codes = (1..10).map { "7KQ2M-9XD4$it" }
        // The account's first method: the codes are kept, shown before anything else, and survive a page being left.
        val on = started.started().keyAdded(Result.success(KeyAdded("f1", "Desk key", false, codes)), first = true)
        assertEquals(codes, on.codes)
        assertNull(on.creation)
        assertEquals(codes, on.cleared().codes)
        assertTrue(TwoStepFlow.removesOthers(turnedOn = on.codes != null, signOutOthers = true, first = true))
        // Turning the step on always comes back with the codes: without them nothing says it is on.
        val odd = started.started().keyAdded(Result.success(KeyAdded("f1", "Desk key", false, emptyList())), first = true)
        assertEquals(StepWords.LOST_TURNED_ON, odd.error)
        assertNull(odd.finished)
        assertEquals(1, odd.reread)
        // Beside other methods: done, in a line, and nobody's devices are removed.
        val beside = started.started().keyAdded(Result.success(KeyAdded("f2", "Phone", true, emptyList())), first = false)
        assertEquals("Passkey or security key added.", beside.finished)
        assertNull(beside.codes)
        assertFalse(TwoStepFlow.removesOthers(turnedOn = false, signOutOthers = true, first = false))
        // The server refused the key: the registration is used up, so the setup ends (back to the password) with its words, and the list is read again.
        val refused = started.started().keyAdded(Result.failure(KeyRefused("That passkey or security key is already added.", 409)), first = false)
        assertNull(refused.creation)
        assertEquals("That passkey or security key is already added.", refused.error)
        assertFalse(refused.pending)
        assertEquals(1, refused.reread)
        // A lost reply may hide a key that was added: said so, never as added, and read again.
        val lost = started.started().keyAdded(Result.failure(LostReply(StepWords.LOST_KEY_ADDED)), first = false)
        assertEquals(StepWords.LOST_KEY_ADDED, lost.error)
        assertNull(lost.finished)
        assertNull(lost.creation)
        assertEquals(1, lost.reread)
    }
}
