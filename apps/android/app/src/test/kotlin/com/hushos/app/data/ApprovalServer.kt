package com.hushos.app.data

import com.hushos.core.base64urlEncode
import com.hushos.core.deviceStepCommitment
import com.hushos.core.randomBytes
import com.hushos.core.stepTokenDigest
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
        const val ACCOUNT = "0f8fad5b-d9cb-469f-a165-70867728950e"
        fun random32(): String = base64urlEncode(randomBytes(32u))
    }

    private val token = TOKEN
    private val account = ACCOUNT

    inner class Call(val method: String, val path: String, val body: JSONObject, val stepToken: String?)

    val calls: MutableList<Call> = Collections.synchronizedList(mutableListOf())
    val requestId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    /* The account the server says the request is for. */
    var userId = account
    var purpose = "login"
    var klass = "unknown"
    var deviceName: String? = "Chrome on Windows"
    var stepToken: String? = null
    var tokenDigest: String? = null
    var commitment: String? = null
    var approverKey: String? = null
    var reveal: Pair<String, String>? = null
    var state = "none"
    var ended = "refused"
    var signature: String? = null
    var deniedFor: String? = null
    /* A server that lies to the answering phone: what it lists in place of what was posted. */
    var listedCommitment: String? = null
    var listedReveal: Pair<String, String>? = null
    /* Takes the next reveal and answers it with a gateway's page. */
    var loseRevealReply = false
    /* Says `opened` however often it is asked, even after the reveal. */
    var staysOpened = false
    /* Refuses to make a request, with this status and body. */
    var refusesStart: Pair<Int, String>? = null
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
            .put("device", JSONObject().put("kind", "web").put("name", deviceName ?: JSONObject.NULL))
            .put("createdAt", "2026-11-14T10:00:00.000Z").put("expiresAt", "2026-11-14T10:05:00.000Z")
            .put("tokenDigest", tokenDigest ?: random32())
            .put("commitment", (if (id == requestId) listedCommitment ?: commitment else null) ?: random32())
        if (id != requestId) return entry
        approverKey?.let { entry.put("approverKey", it) }
        (listedReveal ?: reveal)?.let { (key, nonce) -> entry.put("reveal", JSONObject().put("deviceSigningKey", key).put("nonce", nonce)) }
        return entry
    }

    private fun refusal(message: String, code: String) = JSONObject().put("message", message).put("code", code).toString()

    private fun answer(method: String, path: String, body: JSONObject, header: String?): Pair<Int, String> {
        val own = "/api/auth/approvals/$requestId"
        return when {
            method == "POST" && path == "/api/auth/approvals" -> {
                refusesStart?.let { return it }
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
                200 to JSONObject().put("approverKey", approverKey).toString()
            }
            method == "POST" && path == "$own/approve" -> {
                signature = body.optString("signature")
                state = "approved"
                200 to """{"approved":true}"""
            }
            method == "POST" && path == "$own/deny" -> {
                deniedFor = body.optString("reason")
                state = "ended"
                200 to """{"ended":true}"""
            }
            else -> 404 to """{"message":"Not found."}"""
        }
    }

    /* The other device opens the request, as the server records it. */
    fun open(key: String = random32()) = synchronized(this) { approverKey = key; state = "opened" }
    fun set(next: String, why: String = "refused") = synchronized(this) { state = next; ended = why }
}
