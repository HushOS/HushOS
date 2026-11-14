package com.hushos.app.data

import android.content.Context
import com.hushos.core.ApprovalAckReply
import com.hushos.core.ApprovalEnded
import com.hushos.core.ApprovalPrompt
import com.hushos.core.ApprovalStartReply
import com.hushos.core.ApprovalState
import com.hushos.core.ApprovalStatusReply
import com.hushos.core.ApprovalsReply
import com.hushos.core.DeviceSigningKey
import com.hushos.core.DeviceStep
import com.hushos.core.PromptRequest
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalAckReplyRead
import com.hushos.core.approvalApproveJson
import com.hushos.core.approvalAsks
import com.hushos.core.approvalCodeExpected
import com.hushos.core.approvalCodeNormalize
import com.hushos.core.approvalDenyJson
import com.hushos.core.approvalOpenJson
import com.hushos.core.approvalPromptsAllowed
import com.hushos.core.approvalQr
import com.hushos.core.approvalQrRead
import com.hushos.core.approvalRevealJson
import com.hushos.core.approvalStartJson
import com.hushos.core.approvalStartReplyRead
import com.hushos.core.approvalStatusReplyRead
import com.hushos.core.approvalsReplyRead
import com.hushos.core.base64urlEncode
import com.hushos.core.deviceSigningCreate
import com.hushos.core.deviceSigningPublicKey
import com.hushos.core.deviceStepCode
import com.hushos.core.deviceStepCommitment
import com.hushos.core.deviceStepSign
import com.hushos.core.randomBytes
import com.hushos.core.stepTokenDigest
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/*
 * Approve on another device, as the second step (docs/two-step-design.md 12): the phone that asks
 * and the phone that answers. Everything cryptographic is the core's (`device_approval.rs`), and so
 * is every reply's reading; what is here is the order of things, which is the security of it:
 *
 * - the asking phone commits first, reveals its key and nonce only once another device has fixed
 *   its own value, and only once; it answers the step only with a request that was approved;
 * - the answering phone keeps the commitment as it stood before it opened the request, refuses a
 *   reveal that is not that commitment, and signs only after the code on the other screen was
 *   typed exactly, or its QR code scanned and found to be this very request.
 *
 * The screens are `ui/DeviceApprovalUi.kt`; nothing here draws anything, so all of it is tested
 * without one (`DeviceApprovalTest`). The twin of the iPhone app's `HushOSKit/DeviceApproval.swift`.
 */

/* MARK: The requests */

/*
 * How an approval's requests go out. A sign-in has no session, only its step token; a change, and
 * the phone that answers, send the session's cookie. Tests put their own server here.
 */
class ApprovalWire(
    /* The session the requests go under: what a 401 ends. Null for a sign-in's. */
    val session: Shared.Session? = null,
    /* The method, the path, the body as the core wrote it, and the step token where a read carries it (`x-step-token`). Throws only when nothing came back. */
    val send: (method: String, path: String, body: String?, stepToken: String?) -> Reply,
) {
    data class Reply(val status: Int, val text: String) {
        internal val code: UShort get() = status.coerceIn(0, 65_535).toUShort()
    }

    /* What a refusal is thrown as: an ended session as everywhere, anything else in the server's own words with its code. */
    internal fun refused(reply: Reply, refusal: StepRefusal, message: String): Exception =
        if (reply.status == 401 && refusal == StepRefusal.OTHER && session != null) NotAuthenticated() else StepRefused(refusal, message, reply.status)

    companion object {
        /* A sign-in's: no session yet, and the phones never send one to it. */
        fun signIn(origin: String) = ApprovalWire { method, path, body, stepToken -> Auth.plain(origin, null, method, path, body, stepToken) }

        /* Under `session`, and no other: a request made for one account never goes out under another's. */
        fun signedIn(session: Shared.Session) = ApprovalWire(session) { method, path, body, stepToken -> Auth.plain(session.origin, session, method, path, body, stepToken) }
    }
}

/* A reply that was not the server's answer, to a request that changes nothing by being asked again. */
class Unanswered : AuthFailure(Problems.SERVER)

/* MARK: The key a phone asks with */

/*
 * The device key a sign-in asks another device with (docs/two-step-design.md 12, "The asking
 * device's key"). A phone the account knows, which just proved its key to the server, asks with
 * that key. A phone signing in for the first time makes its device key now, before it has a
 * session, commits to it, and registers with it once it is in (`Auth.registerDevice(made =)`): the
 * key another device approved is the key the phone then has.
 */
class StepDeviceKey(
    /* The 32-byte public key, base64url: what is committed to, and later revealed. */
    val publicKey: String,
    /* Made for this sign-in; null for the phone's own stored key. */
    internal val made: DeviceSigningKey?,
) {
    companion object {
        /* `proved`: the stored key whose proof this sign-in sent; null when it sent none. Null back when no key could be had: nothing is asked then. */
        fun forSignIn(proved: Shared.DeviceIdentity?): StepDeviceKey? {
            if (proved != null) return DeviceApprovals.publicKey(proved)?.let { StepDeviceKey(it, null) }
            val made = runCatching { deviceSigningCreate() }.getOrNull() ?: return null
            return StepDeviceKey(base64urlEncode(made.publicKey), made)
        }
    }
}

/* MARK: The phone that asks */

/* Where a request stands, as the asking screen shows it. In `data/` so the step's own rules (the one button's words) are tested without a screen. */
sealed class AskPhase {
    /* Nothing is out: the screen offers to ask. */
    data object Idle : AskPhase()
    data object Starting : AskPhase()
    /* No device has opened the request: the QR code. */
    data class Waiting(val qr: String) : AskPhase()
    /* A device opened it: the code to type there. */
    data class Code(val code: String) : AskPhase()
    data object Approved : AskPhase()
    /* Over without an approval: why, with Ask again. */
    data class Ended(val line: String) : AskPhase()

    /* A request is out and not yet answered either way. */
    val out: Boolean get() = this is Starting || this is Waiting || this is Code
}

/*
 * One request to another device, from the phone that holds the step token. Made with the
 * commitment and nothing else; the key and the nonce behind it are revealed once a device has
 * opened the request (the server then holds that device's own value, fixed), and only once.
 */
class DeviceAsk private constructor(
    private val wire: ApprovalWire,
    /* The step token the request was made for. */
    val token: String,
    /* What a camera on the other device reads, in place of typing the code. */
    val qr: String,
    private val step: DeviceStep,
    private val nonce: String,
    /* On the clock nobody can set: the request ends with its token, whatever the phone's date says. */
    private val began: Long,
) {
    /* Where the request stands. */
    sealed class State {
        /* No device has opened it: there is no code yet, only the QR code. */
        data object Waiting : State()
        /* A device opened it: the code to type there. */
        data class Code(val code: String) : State()
        /* Approved: the step can be answered with this request. */
        data object Approved : State()
        /* Over without an approval. */
        data class Ended(val why: ApprovalEnded) : State()
    }

    val requestId: String get() = step.requestId

    /* What a step answered with this request carries. */
    val answer: StepAnswer get() = StepAnswer(token, StepProof.Device(requestId))

    private var revealed = false
    private var code: String? = null

    /*
     * Asks where the request stands, and reveals once it may. Before a device opened it nothing is
     * revealed: the commitment is all the server and the other device hold. The code is worked out
     * from the first value the other device fixed, and stays that one. Blocking.
     */
    @Synchronized
    fun poll(): State {
        val reply = wire.send("GET", "/api/auth/approvals/$requestId", null, token)
        return when (val read = approvalStatusReplyRead(reply.code, reply.text)) {
            ApprovalStatusReply.Lost -> throw Unanswered()
            is ApprovalStatusReply.Refused -> throw wire.refused(reply, read.refusal, read.message)
            is ApprovalStatusReply.Status -> when (read.state) {
                ApprovalState.WAITING -> State.Waiting
                ApprovalState.ENDED -> State.Ended(read.ended ?: ApprovalEnded.REFUSED)
                ApprovalState.OPENED, ApprovalState.REVEALED, ApprovalState.APPROVED -> {
                    // The core reads none of these without the other device's value.
                    val approverKey = read.approverKey ?: throw Unanswered()
                    val shown = code ?: deviceStepCode(step, approverKey, nonce).also { code = it }
                    if (read.state == ApprovalState.OPENED) reveal()
                    if (read.state == ApprovalState.APPROVED) State.Approved else State.Code(shown)
                }
            }
        }
    }

    /* Once: marked before the request goes, so a second look never sends another; unmarked only when nothing says the server took it. */
    private fun reveal() {
        if (revealed) return
        revealed = true
        try {
            val reply = wire.send("POST", "/api/auth/approvals/$requestId/reveal", approvalRevealJson(token, step.deviceSigningKey, nonce), null)
            when (val read = approvalAckReplyRead(reply.code, reply.text)) {
                is ApprovalAckReply.Done -> return
                // `device-mismatch` ended the request; any refusal here is the server's last word on this reveal.
                is ApprovalAckReply.Refused -> throw wire.refused(reply, read.refusal, read.message)
                ApprovalAckReply.Lost -> throw Unanswered()
            }
        } catch (refusal: StepRefused) {
            throw refusal
        } catch (error: Exception) {
            // No answer: the server says `revealed` at the next look if it took this one, and nothing is sent again then.
            revealed = false
            throw error
        }
    }

    /*
     * Looks every `every` milliseconds until the request is approved or over, telling `shown` each
     * state on the way. A look that got no answer is made again; a refusal in the server's words is
     * thrown. A request nothing was heard of for as long as a step lasts is over.
     */
    suspend fun wait(every: Long = EVERY_MS, shown: suspend (State) -> Unit = {}): State {
        while (true) {
            currentCoroutineContext().ensureActive()
            if (uptime() - began > PendingSignIn.LIFE_MILLIS) {
                val over = State.Ended(ApprovalEnded.OVER)
                shown(over)
                return over
            }
            val state = try {
                withContext(Dispatchers.IO) { poll() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (refusal: StepRefused) {
                throw refusal
            } catch (ended: NotAuthenticated) {
                throw ended
            } catch (error: Exception) {
                // Nothing came back: asked again.
                null
            }
            if (state != null) {
                shown(state)
                if (state is State.Approved || state is State.Ended) return state
            }
            delay(every)
        }
    }

    /*
     * Waits for the approval, then hands `answer` what the step is answered with. Never before the
     * request is approved. `step-pending` from `answer` is not a wrong answer and not an error: the
     * approval had not landed where the answer went, nothing was counted, and the wait goes on.
     * False when the request ended without an approval: `answer` was never called.
     */
    suspend fun answered(every: Long = EVERY_MS, shown: suspend (State) -> Unit = {}, answer: suspend (StepAnswer) -> Unit): Boolean {
        while (true) {
            if (wait(every, shown) !is State.Approved) return false
            try {
                answer(this.answer)
                return true
            } catch (refusal: StepRefused) {
                if (refusal.refusal != StepRefusal.PENDING) throw refusal
                delay(every)
            }
        }
    }

    companion object {
        /* How often a request is looked at while its screen shows it. */
        const val EVERY_MS = 2_000L

        /*
         * Makes the request for `stepToken`. `purpose` is what the token is for (`login`, a change's own
         * purpose, or `device-approval` when the method is being turned on); `deviceSigningKey` this
         * phone's device key, base64url. `name` is what the phone calls itself, used only by a server
         * that does not know it yet. A refusal is thrown in the server's words (`StepRefused`). Blocking.
         */
        fun start(wire: ApprovalWire, stepToken: String, purpose: String, deviceSigningKey: String, name: String, kind: String = "android"): DeviceAsk {
            val digest = stepTokenDigest(stepToken)
            val nonce = base64urlEncode(randomBytes(32u))
            val commitment = deviceStepCommitment(purpose, digest, deviceSigningKey, nonce)
            val reply = wire.send("POST", "/api/auth/approvals", approvalStartJson(stepToken, commitment, kind, name), null)
            return when (val read = approvalStartReplyRead(reply.code, reply.text)) {
                is ApprovalStartReply.Started ->
                    DeviceAsk(wire, stepToken, approvalQr(read.requestId, commitment), DeviceStep(read.userId, read.requestId, purpose, digest, deviceSigningKey), nonce, uptime())
                is ApprovalStartReply.Refused -> throw wire.refused(reply, read.refusal, read.message)
                ApprovalStartReply.Lost -> throw Unanswered()
            }
        }
    }
}

/* A request another device approved, and the step token it was made for: it answers that token and no other. */
data class ApprovedRequest(val token: String, val requestId: String)

/* MARK: The phone that answers */

/*
 * The approving phone's own limit on prompts (docs/two-step-design.md 12): at most five a day for
 * each class of request, whatever the server lists, counted by the core (`approvalPromptsAllowed`).
 * What it counted is kept with the account's files on this phone and goes with them at sign-out.
 */
class PromptLimit(private val load: () -> String, private val save: (String) -> Unit) {
    /* The requests to show of those the server lists, in its order. */
    @Synchronized
    fun shown(listed: List<ApprovalPrompt>, day: String = day()): List<ApprovalPrompt> {
        // Nothing listed is nothing to count: the list is looked at every few seconds, and mostly empty.
        if (listed.isEmpty()) return emptyList()
        val kept = load()
        val allowed = approvalPromptsAllowed(kept, day, listed.map { PromptRequest(it.id, it.`class`) })
        if (allowed.record != kept) save(allowed.record)
        return listed.filter { it.id in allowed.shown }
    }

    companion object {
        /* An account file (AccountStore): the record as the core wrote it. */
        const val FILE = "approval-prompts.json"

        fun stored(context: Context): PromptLimit {
            val file = File(context.applicationContext.filesDir, FILE)
            return PromptLimit(load = { runCatching { file.readText() }.getOrDefault("") }, save = { record -> runCatching { file.writeText(record) } })
        }

        /* Today as this phone writes it ("2026-11-14"): the day the count is for. */
        fun day(date: java.time.LocalDate = java.time.LocalDate.now()): String = date.toString()
    }
}

object DeviceApprovals {
    /* This phone's device key, when it is the signed-in account's: what it asks with at a change, and signs approvals with. */
    fun identity(session: Shared.Session?, stored: Shared.DeviceIdentity?): Shared.DeviceIdentity? =
        stored?.takeIf { session != null && it.userId.equals(session.userId, ignoreCase = true) }

    internal fun publicKey(identity: Shared.DeviceIdentity): String? = runCatching { base64urlEncode(deviceSigningPublicKey(identity.seed)) }.getOrNull()

    /* The public half, base64url, for the session given; null on a phone that has no device key for it. */
    fun ownKey(session: Shared.Session?, stored: Shared.DeviceIdentity?): String? = identity(session, stored)?.let(::publicKey)

    /* For the session this phone holds now. */
    fun ownKey(context: Context): String? = ownKey(Shared.session(context), Shared.deviceIdentity(context))

    /* The requests this phone may answer now, after its own limit. Blocking. */
    fun list(wire: ApprovalWire, limit: PromptLimit, day: String = PromptLimit.day()): List<ApprovalPrompt> = limit.shown(listed(wire), day)

    /* Everything the server lists for this phone, uncounted: for a request already on screen. */
    internal fun listed(wire: ApprovalWire): List<ApprovalPrompt> {
        val reply = wire.send("GET", "/api/auth/approvals", null, null)
        return when (val read = approvalsReplyRead(reply.code, reply.text)) {
            is ApprovalsReply.Listed -> read.approvals
            is ApprovalsReply.Refused -> throw wire.refused(reply, read.refusal, read.message)
            ApprovalsReply.Lost -> throw Unanswered()
        }
    }
}

/*
 * A push said another device is asking this one to confirm it's you. The service that shows the notice runs
 * in the app's process, so an app that is open hears it here and reads its requests at once (ApprovalInbox).
 * Nothing but a count: the request itself is read from the server, under the session.
 */
object ApprovalPushes {
    private val count = kotlinx.coroutines.flow.MutableStateFlow(0)
    val arrivals: kotlinx.coroutines.flow.StateFlow<Int> get() = count
    fun arrived() { count.value += 1 }
}

/* Why an approval did not happen, in words for the person who was answering. */
sealed class ApprovalProblem(message: String) : AuthFailure(message) {
    /* The other screen's code, or what the other device revealed, is not the request this phone saw: ended, nothing signed. */
    class Mismatch : ApprovalProblem(StepWords.APPROVAL_MISMATCH)
    /* The typed code was not the code: ended, nothing signed. */
    class WrongCode : ApprovalProblem(StepWords.APPROVAL_WRONG_CODE)
    /* The request is over, or another device has it: the server's words. */
    class Over(message: String) : ApprovalProblem(message)
}

/*
 * One request, on the phone that answers it. It holds the request as it was listed before this
 * phone opened it: the purpose, the token's digest and the commitment are those, whatever the
 * server lists afterwards. The account id in what is signed is this phone's own. Every call blocks.
 */
class ApprovalAnswering(
    /* The request as listed before this phone opened it. */
    private val asked: ApprovalPrompt,
    private val wire: ApprovalWire,
    /* This phone's own account id and device key. */
    private val userId: String,
    private val seed: ByteArray,
) {
    /* Why the request is ended from here. `mismatch` is not a failed step; the others are. */
    enum class Ending(val wire: String) { DENIED("denied"), WRONG_CODE("wrong-code"), NOT_ME("not-me"), MISMATCH("mismatch") }

    val id: String = asked.id

    /* "Sign-in on Chrome on Windows": what is asked, and by which device. */
    val asks: String = approvalAsks(asked.purpose, asked.deviceName)

    /* This phone's own value, once it opened the request: the first one, if it opened it before. */
    private var approverKey: String? = null

    /* The code this phone expects, and what it signs, once the other device revealed what it committed to. */
    private var ready: Pair<String, DeviceStep>? = null

    /* The other screen's QR code was read, and it was this request: the commitment was the check, and no code is typed. */
    @get:Synchronized
    var scanned = false
        private set

    private fun post(action: String, body: String): ApprovalAckReply {
        val reply = wire.send("POST", "/api/auth/approvals/$id/$action", body, null)
        val read = approvalAckReplyRead(reply.code, reply.text)
        if (read is ApprovalAckReply.Refused) {
            if (reply.status == 401 && read.refusal == StepRefusal.OTHER) throw NotAuthenticated()
            // Over, taken by another device, or a signature that did not verify: the server's own sentence.
            throw ApprovalProblem.Over(read.message)
        }
        return read
    }

    /*
     * What a camera read from the other screen. False for anything that is not an approval's code
     * (another QR code in view): nothing happens. A code for another request, or with another
     * commitment than the server listed for this one, is not the request on that screen: this one
     * is ended (`mismatch`) and nothing is opened. Otherwise the request is opened.
     */
    @Synchronized
    fun openScanned(text: String): Boolean {
        val read = approvalQrRead(text) ?: return false
        if (read.requestId != asked.id || read.commitment != asked.commitment) {
            runCatching { end(Ending.MISMATCH) }
            throw ApprovalProblem.Mismatch()
        }
        open()
        scanned = true
        return true
    }

    /* Opens the request: this phone's own 32 fresh bytes go in, and only then does the other device reveal. */
    @Synchronized
    fun open() {
        if (approverKey != null) return
        val own = asked.approverKey ?: base64urlEncode(randomBytes(32u))
        approverKey = (post("open", approvalOpenJson(own)) as? ApprovalAckReply.Done)?.approverKey ?: throw Unanswered()
    }

    /*
     * One look for what the other device revealed. False while it has not. What it revealed must be
     * what it committed to before this phone opened the request, for the purpose and token listed
     * then: if it is not, no honest device is on the other side, the request is ended (`mismatch`)
     * and nothing is ever signed for it. A request that left the list is over.
     */
    @Synchronized
    fun revealed(): Boolean {
        if (ready != null) return true
        val approverKey = approverKey ?: return false
        val now = DeviceApprovals.listed(wire).firstOrNull { it.id == id } ?: throw ApprovalProblem.Over(StepWords.APPROVAL_OVER)
        val key = now.revealKey ?: return false
        val nonce = now.revealNonce ?: return false
        val step = DeviceStep(userId, id, asked.purpose, asked.tokenDigest, key)
        val code = try {
            approvalCodeExpected(step, asked.commitment, approverKey, nonce)
        } catch (error: Exception) {
            runCatching { end(Ending.MISMATCH) }
            throw ApprovalProblem.Mismatch()
        }
        ready = code to step
        return true
    }

    /* Looks every `every` milliseconds until the other device revealed. A look that got no answer is made again. */
    suspend fun awaitReveal(every: Long = DeviceAsk.EVERY_MS) {
        val began = uptime()
        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                if (withContext(Dispatchers.IO) { revealed() }) return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (problem: ApprovalProblem) {
                throw problem
            } catch (ended: NotAuthenticated) {
                throw ended
            } catch (error: Exception) {
                // Nothing came back: asked again.
            }
            if (uptime() - began > PendingSignIn.LIFE_MILLIS) throw ApprovalProblem.Over(StepWords.APPROVAL_OVER)
            delay(every)
        }
    }

    /*
     * Approves. After a scan the commitment was the check and nothing is typed (`typed` null).
     * Otherwise only the exact code is approved: anything else ends the request (`wrong-code`),
     * and nothing is signed. The signature is this phone's device key's, over the statement that
     * names this phone's own account, the request, its purpose, its token and the asking device.
     */
    @Synchronized
    fun approve(typed: String?) {
        val (code, step) = ready ?: throw Unanswered()
        if (!(scanned && typed == null)) {
            if (typed == null || approvalCodeNormalize(typed) != code) {
                runCatching { end(Ending.WRONG_CODE) }
                throw ApprovalProblem.WrongCode()
            }
        }
        val signature = deviceStepSign(seed, step)
        if (post("approve", approvalApproveJson(signature)) !is ApprovalAckReply.Done) throw LostReply(StepWords.LOST_CHANGE)
    }

    /* Deny, or This wasn’t me: the request ends, and is counted as a failed step. */
    @Synchronized
    fun end(why: Ending) {
        if (post("deny", approvalDenyJson(why.wire)) !is ApprovalAckReply.Done) throw LostReply(StepWords.LOST_CHANGE)
    }
}

/* MARK: Turning the method on */

/* A pending Approve on another device: its id, and the step token its one approval runs from (purpose `device-approval`). */
data class DeviceEnrolment(val id: String, val token: String) {
    companion object {
        const val PURPOSE = "device-approval"
    }
}
