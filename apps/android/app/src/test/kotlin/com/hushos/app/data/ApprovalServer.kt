package com.hushos.app.data

import com.hushos.core.base64urlEncode
import com.hushos.core.deviceStepCommitment
import com.hushos.core.randomBytes
import com.hushos.core.stepTokenDigest
import com.hushos.core.turnOnCodeDigest
import java.util.Collections
import org.json.JSONArray
import org.json.JSONObject

/*
 * The approvals routes (docs/two-step-design.md 12), in memory: a small server that does what the real one does
 * with each route, and can be made to lie where a test needs a server that lies. Shared by the tests of the
 * requests themselves (`DeviceApprovalTest`) and of what a screen holds while one is out (`DeviceApprovalUiTest`).
 */
internal class ApprovalServer {
    companion object {
        val TOKEN = "t".repeat(43)
        /* The purpose of the request that turns the method on. */
        const val TURNS_ON = "device-approval"
        const val ACCOUNT = "0f8fad5b-d9cb-469f-a165-70867728950e"
        fun random32(): String = base64urlEncode(randomBytes(32u))
    }

    private val token = TOKEN
    private val account = ACCOUNT

    inner class Call(val method: String, val path: String, val body: JSONObject, val stepToken: String?)

    val calls: MutableList<Call> = Collections.synchronizedList(mutableListOf())
    /* The request that is out. Each one made here after the first has an id of its own, as on the real server. */
    var requestId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        private set
    private var made = 0
    /* The account the server says the request is for. */
    var userId = account
    var purpose = "login"
    var klass = "unknown"
    var deviceName: String? = "Chrome on Windows"
    /* When the asking device was added to the account, where it is one of its devices; null leaves the field out. */
    var addedAt: String? = null
    /* What the list says of the name and of who was asked; null leaves the field out, as a server from before it does. */
    var selfNamed: Boolean? = null
    var chosen: Boolean? = null
    var location: String? = null
    var stepToken: String? = null
    var tokenDigest: String? = null
    var commitment: String? = null
    var approverKey: String? = null
    var reveal: Pair<String, String>? = null
    var state = "none"
    var ended = "refused"
    var signature: String? = null
    /* The digest of the code the approving device drew, kept while the request that turns the method on is approved. Handed back by no route. */
    var codeDigest: String? = null
        private set
    var deniedFor: String? = null
    /* A server that lies to the answering phone: what it lists in place of what was posted. */
    var listedCommitment: String? = null
    var listedReveal: Pair<String, String>? = null
    /* Takes the next reveal and answers it with a gateway's page. */
    var loseRevealReply = false
    var loseOpenReply = false
    /* Takes the next approval and answers it with a gateway's page. */
    var loseApproveReply = false
    /* Says `opened` however often it is asked, even after the reveal. */
    var staysOpened = false
    /* Refuses to make a request, with this status and body. */
    var refusesStart: Pair<Int, String>? = null
    /* A server that lies to the answering phone about its own value: what it answers an open with, whatever was posted. */
    var echoes: String? = null
    /* The list says a device opened the request with this, though nothing here posted it. */
    var listedApproverKey: String? = null
    /* Other requests in the list, as (id, class). */
    var others: List<Pair<String, String>> = emptyList()

    fun calls(suffix: String): List<Call> = synchronized(calls) { calls.filter { it.path.endsWith(suffix) } }

    fun wire(session: Shared.Session? = Shared.Session("http://step.test", "session-token", account)) = ApprovalWire(session) { method, path, body, stepToken ->
        synchronized(this) {
            val parsed = body?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
            calls += Call(method, path, parsed, stepToken)
            val (status, text) = answer(method, path, parsed, stepToken)
            ApprovalWire.Reply(status, text)
        }
    }

    /* A request as an asking device made it, for the tests that only answer. */
    fun asked(purpose: String = "login", key: String = random32(), nonce: String = random32()): Pair<String, String> {
        this.purpose = purpose
        stepToken = token
        tokenDigest = stepTokenDigest(token)
        commitment = deviceStepCommitment(purpose, tokenDigest!!, key, nonce)
        state = "waiting"
        return key to nonce
    }

    private fun entry(id: String, klass: String): JSONObject {
        val entry = JSONObject().put("id", id).put("purpose", purpose).put("class", klass)
            .put("device", JSONObject().put("kind", "web").put("name", deviceName ?: JSONObject.NULL).apply { if (id == requestId) addedAt?.let { put("addedAt", it) } })
            .put("createdAt", "2026-11-14T10:00:00.000Z").put("expiresAt", "2026-11-14T10:05:00.000Z")
            .put("tokenDigest", tokenDigest ?: random32())
            .put("commitment", (if (id == requestId) listedCommitment ?: commitment else null) ?: random32())
        if (id != requestId) return entry
        selfNamed?.let { entry.put("selfNamed", it) }
        chosen?.let { entry.put("chosen", it) }
        location?.let { entry.put("location", it) }
        (listedApproverKey ?: approverKey)?.let { entry.put("approverKey", it) }
        (listedReveal ?: reveal)?.let { (key, nonce) -> entry.put("reveal", JSONObject().put("deviceSigningKey", key).put("nonce", nonce)) }
        return entry
    }

    private fun refusal(message: String, code: String) = JSONObject().put("message", message).put("code", code).toString()

    private fun answer(method: String, path: String, body: JSONObject, header: String?): Pair<Int, String> {
        val own = "/api/auth/approvals/$requestId"
        return when {
            method == "POST" && path == "/api/auth/approvals" -> {
                refusesStart?.let { return it }
                // A new request: its own id, and nothing of the one before it.
                if (made++ > 0) requestId = java.util.UUID.randomUUID().toString()
                approverKey = null
                reveal = null
                signature = null
                codeDigest = null
                deniedFor = null
                stepToken = body.optString("stepToken")
                tokenDigest = stepTokenDigest(stepToken!!)
                commitment = body.optString("commitment")
                state = "waiting"
                200 to JSONObject().put("requestId", requestId).put("userId", userId).put("expiresAt", "2026-11-14T10:05:00.000Z").toString()
            }
            method == "GET" && path == own -> {
                if (header != stepToken) return 401 to refusal("This sign-in timed out.", "step-expired")
                val status = JSONObject().put("state", if (staysOpened && state == "revealed") "opened" else state)
                if (approverKey != null && state != "waiting" && state != "ended") status.put("approverKey", approverKey)
                if (state == "ended") status.put("ended", ended)
                200 to status.toString()
            }
            method == "POST" && path == "$own/reveal" -> {
                val key = body.optString("deviceSigningKey")
                val nonce = body.optString("nonce")
                if (state != "opened" || runCatching { deviceStepCommitment(purpose, tokenDigest.orEmpty(), key, nonce) }.getOrNull() != commitment) {
                    state = "ended"
                    return 400 to refusal("That didn’t match the request.", "device-mismatch")
                }
                reveal = key to nonce
                state = "revealed"
                if (loseRevealReply) {
                    loseRevealReply = false
                    return 502 to "<html>Bad gateway</html>"
                }
                200 to """{"revealed":true}"""
            }
            method == "GET" && path == "/api/auth/approvals" -> {
                val live = state in listOf("waiting", "opened", "revealed")
                val all = JSONArray()
                if (live) all.put(entry(requestId, klass))
                others.forEach { (id, klass) -> all.put(entry(id, klass)) }
                200 to JSONObject().put("userId", "someone-else").put("approvals", all).toString()
            }
            method == "POST" && path == "$own/open" -> {
                if (state !in listOf("waiting", "opened", "revealed")) return 404 to refusal("This request is over.", "approval-over")
                approverKey = approverKey ?: body.optString("ephemeralKey")
                if (state == "waiting") state = "opened"
                // The value was taken, and what came back is not the server's answer (a proxy's page, a cut connection).
                if (loseOpenReply) return 200 to "{}"
                200 to JSONObject().put("approverKey", echoes ?: approverKey).toString()
            }
            method == "POST" && path == "$own/approve" -> {
                // The request that turns the method on is approved with the digest of the code its approving device
                // drew, and no other request is: anything else is no approval, and changes nothing.
                val digest = body.optString("codeDigest").ifEmpty { null }
                if ((purpose == TURNS_ON) != (digest != null) || (digest != null && digest.length != 43)) return 400 to """{"message":"Update HushOS on this device to approve that."}"""
                // Sent again with the same digest (its reply was lost) it is the same approval; with another it is refused.
                if (state == "approved" && digest != null) {
                    return if (digest == codeDigest) 200 to """{"approved":true}""" else 409 to """{"message":"The other device hasn’t shown its code yet."}"""
                }
                if (state !in listOf("waiting", "opened", "revealed")) return 404 to refusal("This request is over.", "approval-over")
                signature = body.optString("signature")
                codeDigest = digest
                state = "approved"
                if (loseApproveReply) {
                    loseApproveReply = false
                    return 502 to "<html>Bad gateway</html>"
                }
                200 to """{"approved":true}"""
            }
            method == "POST" && path == "$own/deny" -> {
                deniedFor = body.optString("reason")
                codeDigest = null
                state = "ended"
                200 to """{"ended":true}"""
            }
            method == "POST" && path.startsWith("/api/auth/two-step/device/") && path.endsWith("/confirm") -> confirm(body)
            else -> 404 to """{"message":"Not found."}"""
        }
    }

    /*
     * `POST two-step/device/:id/confirm`: the method is turned on only by the code the approving device drew, which
     * this server never saw. It holds the typed code's digest to the one the approval carried, once: a code that is
     * not it ends the request (409 `device-code`), and the pending method stands.
     */
    private fun confirm(body: JSONObject): Pair<Int, String> {
        if (body.optString("token") != stepToken || body.optString("requestId") != requestId || state == "ended") return 404 to """{"message":"Start again."}"""
        if (state != "approved") return 409 to refusal("Waiting for your other device.", "step-pending")
        val kept = codeDigest ?: return 404 to """{"message":"Start again."}"""
        // What is no code at all is refused before anything is looked at, and changes nothing.
        val typed = runCatching { turnOnCodeDigest(requestId, body.optString("code")) }.getOrNull() ?: return 400 to """{"message":"That is not a code."}"""
        if (typed != kept) {
            codeDigest = null
            state = "ended"
            return 409 to refusal("That code didn’t match, so nothing was turned on.", "device-code")
        }
        confirmed = true
        return 200 to """{"backupCodes":["7KQ2M-9XD4P","AAAAA-BBBBB"]}"""
    }

    /* A confirmation carried the approving device's code: the method is on. */
    var confirmed = false
        private set

    /* The path a pending method is confirmed at, whichever its id. */
    val confirmPath = "/api/auth/two-step/device/5b2c0f0e-6f0a-4d0c-9a57-2f1a3a8f6f10/confirm"

    /* The other device opens the request, as the server records it. */
    fun open(key: String = random32()) = synchronized(this) { approverKey = key; state = "opened" }
    fun set(next: String, why: String = "refused") = synchronized(this) { state = next; ended = why }
}
