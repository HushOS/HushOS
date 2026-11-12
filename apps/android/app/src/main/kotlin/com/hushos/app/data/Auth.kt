package com.hushos.app.data

import android.content.Context
import com.hushos.core.AccountKeyEnvelope
import com.hushos.core.accountSeal
import com.hushos.core.accountUnlock
import com.hushos.core.deviceEmailHash
import com.hushos.core.deviceRemember
import com.hushos.core.deviceSessionSign
import com.hushos.core.deviceSigningCreate
import com.hushos.core.opaqueFinishLogin
import com.hushos.core.opaqueFinishRegistration
import com.hushos.core.opaqueStartLogin
import com.hushos.core.opaqueStartRegistration
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

data class SessionUser(val id: String, val name: String, val email: String, val credentialVersion: ULong) {
    companion object {
        fun from(json: JSONObject) = SessionUser(json.getString("id"), json.optString("name"), json.optString("email"), json.optLong("credentialVersion").toULong())
    }
}

/* `status` is the HTTP status when the server refused, 0 otherwise: 409 on settings means another device saved first. */
open class AuthFailure(message: String, val status: Int = 0) : Exception(message)

/* An answer other than 200 to the session check: not about the session (see sessionCheck), handled as being offline. */
class SessionUnavailable(val status: Int) : java.io.IOException("HushOS answered $status while checking the session.")

/* The account has no recovery words to show (no recovery key on the server): a definite answer, unlike a failure. */
class NoRecoveryKey : AuthFailure("This account has no recovery key.")

/* An account call that couldn't reach the server: offline, told apart by its type (Problems.offline), never by its words. */
class AuthUnreachable : AuthFailure(Auth.UNREACHABLE)

/* The session's device: which one, and whether it has described itself yet. */
data class SessionDevice(val id: String, val registered: Boolean) {
    companion object {
        fun from(json: JSONObject?): SessionDevice? = json?.optString("id")?.ifEmpty { null }?.let { SessionDevice(it, json.optBoolean("registered")) }
    }
}

/* What the server says about the stored session: whose it is and its device, gone, or gone because its device was removed. */
sealed class SessionCheck {
    data class SignedIn(val user: SessionUser, val device: SessionDevice?) : SessionCheck()
    data object Ended : SessionCheck()
    data object Removed : SessionCheck()

    companion object {
        fun from(body: JSONObject): SessionCheck {
            val user = body.optJSONObject("user")?.let(SessionUser::from)
            return when {
                user != null -> SignedIn(user, SessionDevice.from(body.optJSONObject("device")))
                body.optBoolean("removed") -> Removed
                else -> Ended
            }
        }
    }
}

/* One of the account's devices, as the list shows it. Kind and name are null for a device that never described itself. */
data class AccountDevice(
    val id: String, val kind: String?, val name: String?, val approvedBy: String?,
    val createdAt: String, val lastSeenAt: String, val current: Boolean, val signedIn: Boolean,
) {
    /* What the list calls it: its name, else what it is, else an unknown device. */
    val label: String get() = name?.ifEmpty { null } ?: when (kind) {
        "android" -> "Android phone"
        "ios" -> "iPhone"
        "web" -> "A web browser"
        else -> "Unknown device"
    }

    /* How it got in, in the words the web uses. */
    val approval: String? get() = when (approvedBy) {
        "enrolment" -> "Where you created your account"
        "password" -> "Signed in with your password"
        "existing" -> "Already signed in when HushOS began listing devices"
        "device" -> "Approved by another of your devices"
        "phrase" -> "Approved with your recovery phrase"
        "email-wait" -> "Approved after the email wait"
        "guardian" -> "Approved by a guardian"
        else -> null
    }

    companion object {
        fun from(json: JSONObject): AccountDevice {
            fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }
            return AccountDevice(
                json.getString("id"), json.text("kind"), json.text("name"), json.text("approvedBy"),
                json.getString("createdAt"), json.getString("lastSeenAt"), json.optBoolean("current"), json.optBoolean("signedIn"),
            )
        }
    }
}

/*
 * `/api/auth/storage`. While the account's own files draw from a family's pool
 * (docs/families-shared-pool.md 3.1) the figures are the pool's, counted part by
 * part in whole GiB so they give away no one member's usage (3.9), and `pool`
 * names the family; on the account's own allowance, or on a server older than
 * the pool or without billing, it is null or absent. A pool this build can't
 * read is no pool: the figures still show under today's words.
 */
data class StorageAllowance(val quotaBytes: Long, val usedBytes: Long, val availableBytes: Long, val pool: StoragePool? = null) {
    /*
     * What an upload can still take, as the server checks it. Never quota less used: in a pool
     * the server leaves other members' uploads in flight out of `usedBytes` (they would give
     * away one member's activity) and takes them off `availableBytes` only.
     */
    val free: Long get() = availableBytes.coerceAtLeast(0L)

    companion object {
        fun from(json: JSONObject) = StorageAllowance(
            json.getString("quotaBytes").toLong(), json.getString("usedBytes").toLong(), json.getString("availableBytes").toLong(),
            json.optJSONObject("pool")?.let(StoragePool::from),
        )
    }
}

/* The family whose pool the storage figures are: both fields strings, neither empty. */
data class StoragePool(val groupId: String, val name: String) {
    companion object {
        fun from(json: JSONObject): StoragePool? {
            // `opt` and a type check, never `optString`, which turns a number into its digits.
            val groupId = json.opt("groupId") as? String
            val name = json.opt("name") as? String
            return if (groupId.isNullOrEmpty() || name.isNullOrBlank()) null else StoragePool(groupId, name)
        }
    }
}

data class BillingSummary(
    val enabled: Boolean,
    val planName: String?,
    val periodEnd: String?,
    val cancelAtPeriodEnd: Boolean,
    /* The family whose plan the storage comes from while pooled; absent on older servers. */
    val family: BillingFamily? = null,
    /* Polar's status for the personal plan, and when it ended: `/api/billing` keeps answering with the last plan. */
    val status: String? = null,
    val endedAt: String? = null,
) {
    val standing: PlanStanding get() = if (planName == null) PlanStanding.ENDED else PlanStanding.of(status, endedAt)

    companion object {
        fun from(json: JSONObject): BillingSummary {
            val subscription = json.optJSONObject("subscription")
            return BillingSummary(
                json.optBoolean("enabled"), subscription?.optString("productName"), subscription?.optString("currentPeriodEnd"),
                subscription?.optBoolean("cancelAtPeriodEnd") ?: false, json.optJSONObject("family")?.let(BillingFamily::from),
                // `opt` and a type check: a JSON null is JSONObject.NULL, which `optString` turns into "null".
                subscription?.opt("status") as? String, subscription?.opt("endedAt") as? String,
            )
        }
    }
}

/*
 * What a personal plan's status means, as the web's `planStanding`
 * (packages/billing/src/protocol.ts). Only a live plan (active, trialing, or
 * past_due while Polar retries a renewal) gives its storage and is the plan
 * Account names. `unpaid` and `incomplete` (a payment that never went through)
 * and `paused` haven't ended, since a payment or a resume brings them back, but
 * give nothing: the person is on Free meanwhile. An ended plan, `canceled`,
 * `incomplete_expired`, or a status Polar adds later is Free. A server that
 * records an unpaid plan as ended lands on Free too, never on "Renews".
 */
enum class PlanStanding {
    LIVE, PAYMENT_FAILED, PAUSED, ENDED;

    companion object {
        fun of(status: String?, endedAt: String?): PlanStanding = when {
            endedAt != null -> ENDED
            status == "active" || status == "trialing" || status == "past_due" -> LIVE
            status == "unpaid" || status == "incomplete" -> PAYMENT_FAILED
            status == "paused" -> PAUSED
            else -> ENDED
        }
    }
}

/* A personal plan Polar still holds that gives nothing: its payment failed, or it is paused. */
data class LapsedPlan(
    /* "Pro", without an interval the product's name may end in ("Pro (monthly)"). */
    val name: String,
    val paused: Boolean,
) {
    /* The card's line: "Pro’s payment didn’t go through", "Pro is paused". */
    val line: String get() = if (paused) "$name is paused" else "$name’s payment didn’t go through"
    /* Why the room is Free's, for Plan and storage and Not enough room. */
    val room: String get() = if (paused) "$name is paused, so you have Free’s storage until it resumes."
        else "$name’s payment didn’t go through, so you have Free’s storage for now."

    companion object {
        private val interval = Regex("""\s*\((monthly|yearly|annual)\)\s*$""", RegexOption.IGNORE_CASE)
        fun of(productName: String, paused: Boolean) = LapsedPlan(productName.replace(interval, ""), paused)
    }
}

/* The family whose plan a pooled person's storage comes from: a name that isn't blank, as for a pool. */
data class BillingFamily(val name: String, val planName: String?) {
    companion object {
        fun from(json: JSONObject): BillingFamily? {
            val name = (json.opt("name") as? String)?.takeUnless { it.isBlank() } ?: return null
            return BillingFamily(name, (json.opt("planName") as? String)?.trim()?.ifEmpty { null })
        }
    }
}

/*
 * What Account says about the plan (docs/families-shared-pool.md 9). Read only,
 * as all billing on the phone is: no way to buy or change a plan here (Google
 * Play's payments policy, as Apple's 3.1.3(f) on iOS).
 *
 * While the storage figures are a family's pool, the plan is the family's: its
 * name from `/api/billing`'s `family` ("Family plan" until that answers) and the
 * line "Shared with <family>" (no possessive: "The Lindqvists’s" reads badly). A personal plan is never shown then, since the
 * person no longer draws from it (billing ends it, 5.1). Without a readable
 * `pool` it is the personal plan while it is live (PlanStanding), else Free,
 * with the lapsed plan's words when its payment failed or it is paused.
 */
data class PlanDisplay(
    /* The plan's name, the card's heading. */
    val name: String,
    /* "Shared with Lindqvist family" while pooled, else null. */
    val source: String?,
    /* The family's name while pooled, for labels that would otherwise read as the person's own. */
    val family: String?,
    /* The live personal plan's renewal or end date, shown only when not pooled. */
    val periodEnd: String?,
    val cancelAtPeriodEnd: Boolean,
    /* The live personal plan's renewal is past due: Polar is still retrying it. */
    val overdue: Boolean = false,
    /* The personal plan that gives nothing until it is paid for or resumed; null while pooled. */
    val lapsed: LapsedPlan? = null,
) {
    companion object {
        fun of(allowance: StorageAllowance?, billing: BillingSummary?): PlanDisplay {
            // The storage answer decides; the billing one only when storage didn't answer at all,
            // so a failed read never puts back a personal plan the person no longer draws from.
            val family = if (allowance != null) allowance.pool?.name else billing?.family?.name
            return if (family != null) {
                PlanDisplay(billing?.family?.planName ?: "Family plan", "Shared with $family", family, null, false)
            } else {
                val name = billing?.planName?.takeIf { it.isNotEmpty() }
                val standing = billing?.standing ?: PlanStanding.ENDED
                when {
                    billing == null || standing == PlanStanding.ENDED -> PlanDisplay("Free", null, null, null, false)
                    standing == PlanStanding.LIVE -> PlanDisplay(name ?: "Free", null, null, billing.periodEnd, billing.cancelAtPeriodEnd, overdue = billing.status == "past_due")
                    else -> PlanDisplay("Free", null, null, null, false, lapsed = LapsedPlan.of(name ?: "Your plan", standing == PlanStanding.PAUSED))
                }
            }
        }
    }
}

/*
 * OPAQUE sign-in against the HushOS API, entirely native: the Rust core runs
 * the client steps; the session cookie goes to the encrypted store; a device
 * bundle is made when there is none for this user and credential, so the
 * documents provider can open the account key afterwards.
 */
object Auth {
    /* The two sign-in failures a person can act on, in the words the board settles on. */
    const val MISMATCH = "That email and password don’t match. Check them and try again."
    const val UNREACHABLE = "We couldn’t reach HushOS. Check your connection, then try again."
    /* Fixed words for a phrase the core refused: its own text (a type name, a detail) never reaches the screen. */
    fun phraseRefused(coreMessage: String?): String {
        val said = coreMessage?.substringAfter(": ").orEmpty()
        return if (said.isBlank() || said.startsWith("The recovery phrase does not match")) PHRASE_REFUSED else PHRASE_UNCHECKED
    }

    /* Fixed words for a reset whose last step failed, whatever that step said. */
    fun resetUnfinished(error: AuthFailure): String = if (error is AuthUnreachable) RESET_UNREACHABLE else RESET_UNFINISHED

    const val PHRASE_REFUSED = "These words didn’t open your account. Check you used your newest kit."
    const val PHRASE_UNCHECKED = "These words couldn’t be checked. Check you used your newest kit, then try again."
    const val RESET_UNREACHABLE = "We couldn’t reach HushOS to finish the reset. Try signing in with your new password first: the reset may already have been applied."
    const val RESET_UNFINISHED = "The reset didn’t finish. Try signing in with your new password first: it may already have been applied."

    private class Reply(val body: JSONObject, val cookie: String?, val enrollment: String? = null)

    /* A reply as it arrived: the status, the body as text for the core to read, and the cookies if any came. */
    internal class RawReply(val status: Int, val text: String, val body: JSONObject, val cookie: String?, val enrollment: String?)

    /* Sends and returns whatever came back, any status; throws only when nothing did. */
    internal fun send(origin: String, path: String, body: JSONObject, cookie: String? = null): RawReply {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Origin", origin)
        connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
        if (cookie != null) connection.setRequestProperty("Cookie", cookie)
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        val status: Int
        val text: String
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw AuthUnreachable()
        }
        val parsed = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        var token: String? = null
        var enrollment: String? = null
        for (header in connection.headerFields["Set-Cookie"].orEmpty()) {
            val pair = header.split(";")[0].trim()
            if (pair.startsWith("hushos-session=") || pair.startsWith("__Host-hushos-session=")) token = pair.substringAfter("=").ifEmpty { null }
            if (pair.startsWith("hushos-enrollment=") || pair.startsWith("__Host-hushos-enrollment=")) enrollment = pair.substringAfter("=").ifEmpty { null }
        }
        return RawReply(status, text, parsed, token, enrollment)
    }

    private fun post(origin: String, path: String, body: JSONObject, cookie: String? = null): Reply {
        val reply = send(origin, path, body, cookie)
        if (reply.status !in 200..299) throw AuthFailure(Problems.signIn(reply.status, reply.body.optString("message")))
        return Reply(reply.body, reply.cookie, reply.enrollment)
    }

    /*
     * Account recovery, as the web's /recover: the server emails a link; the link proves the
     * address (and leaves an enrollment token, kept here in memory only); the 24 words open
     * the account key; a new password registers again and seals it; a new phrase replaces the
     * old one, signed with the old phrase's key so the server knows the words were right.
     */
    fun requestRecoveryEmail(origin: String, email: String): String =
        post(origin, "/api/auth/recover/email", JSONObject().put("email", email)).body.optString("message")

    /* The email link's token: the address it was sent to, and the enrollment the next steps need. */
    data class RecoveryEnrollment(val email: String, val token: String)

    fun verifyRecoveryLink(origin: String, verifyToken: String): RecoveryEnrollment {
        val reply = post(origin, "/api/auth/register/verify", JSONObject().put("token", verifyToken))
        val enrollment = reply.body.optJSONObject("enrollment") ?: throw AuthFailure("This link didn’t work.")
        if (enrollment.optString("purpose") != "recover") throw AuthFailure("This link belongs to a different account flow. Request a new link.")
        return RecoveryEnrollment(enrollment.getString("email"), reply.enrollment ?: throw AuthFailure("This link didn’t work."))
    }

    /* Resets the password with the phrase; returns the new phrase to save. The caller signs in with the new password. */
    /* The account a recovery opened, and its new phrase. */
    data class Recovered(val userId: String, val phrase: String)

    fun recover(origin: String, enrollment: RecoveryEnrollment, phrase: String, password: String): Recovered {
        val cookie = (if (origin.startsWith("https:")) "__Host-hushos-enrollment" else "hushos-enrollment") + "=" + enrollment.token
        val registration = opaqueStartRegistration(password)
        val challenge = post(origin, "/api/auth/recover/start", JSONObject().put("registrationRequest", registration.request), cookie).body
        val userId = challenge.getString("userId")
        val current = recoveryEnvelope(challenge.getJSONObject("recovery"))
        val credentialVersion = challenge.getLong("credentialVersion").toULong()
        // The phrase opens the account key (and is refused when it isn't this account's).
        val accountKey = try {
            com.hushos.core.recoveryOpen(userId, phrase, current)
        } catch (error: com.hushos.core.CoreException) {
            // The web's words for a phrase that isn't this account's (or is an older kit's). The core's own text is
            // for developers: it goes to the log, and anything else the core refused gets fixed words too.
            android.util.Log.w("HushOS", "recovery phrase refused", error)
            throw AuthFailure(phraseRefused(error.message))
        }
        val registered = opaqueFinishRegistration(password, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, accountKey, current.keyVersion, credentialVersion + 1uL)
        val next = com.hushos.core.recoveryCreate(userId, accountKey, current.recoveryVersion + 1uL, current.keyVersion)
        val attempt = challenge.getString("attemptToken")
        val signature = com.hushos.core.recoveryResetSign(userId, phrase, current, attempt, credentialVersion, registered.record, sealed, next.envelope)
        try {
            post(origin, "/api/auth/recover/finish", JSONObject().put("userId", userId).put("attemptToken", attempt)
                .put("credentialVersion", credentialVersion.toLong()).put("registrationRecord", registered.record)
                .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                    .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                    .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
                .put("recovery", json(next.envelope)).put("signature", signature), cookie)
        } catch (error: AuthFailure) {
            // The server may have committed before the reply was lost: say so, as the web does, in fixed words.
            android.util.Log.w("HushOS", "recovery finish failed", error)
            throw AuthFailure(resetUnfinished(error))
        }
        return Recovered(userId, next.phrase)
    }

    /*
     * Sign-up, as the web's /register: the server emails a link; the link proves the address and
     * leaves an enrollment token (kept in memory only); the password registers with OPAQUE; every
     * key is made here by the core (account_create) and only sealed halves and public keys are
     * sent. The caller then signs in with the password, as the web does, and reads the phrase back.
     */
    fun requestSignupEmail(origin: String, email: String): String =
        // `app`: the link comes back as /register/complete?app=1, as iOS needs it (its apple-app-site-association claims only that).
        post(origin, "/api/auth/register/email", JSONObject().put("email", email).put("app", true)).body.optString("message")

    /* A sign-up link's enrollment: the address it confirmed and the token the next steps need. */
    /* `origin`: the server that issued it, the only one its token is ever sent to (a server changed since never sees it). */
    data class SignupEnrollment(val email: String, val token: String, val origin: String)

    fun verifySignupLink(origin: String, verifyToken: String): SignupEnrollment {
        val reply = post(origin, "/api/auth/register/verify", JSONObject().put("token", verifyToken))
        val enrollment = reply.body.optJSONObject("enrollment") ?: throw AuthFailure("This link didn’t work.")
        if (enrollment.optString("purpose") != "register") throw AuthFailure("This link belongs to a different account flow. Request a new link.")
        return SignupEnrollment(enrollment.getString("email"), reply.enrollment ?: throw AuthFailure("This link didn’t work."), origin)
    }

    /*
     * Creates the account; returns its user id. The caller signs in next. The one thing stored is the RecoveryWords
     * marker, set before the account is sent: if the server makes it but its answer is lost, the words still come first
     * at the next sign-in, here or in a picker.
     */
    fun register(enrollment: SignupEnrollment, name: String, password: String): String {
        val origin = enrollment.origin
        val cookie = (if (origin.startsWith("https:")) "__Host-hushos-enrollment" else "hushos-enrollment") + "=" + enrollment.token
        val registration = opaqueStartRegistration(password)
        val challenge = post(origin, "/api/auth/register/start", JSONObject().put("registrationRequest", registration.request), cookie).body
        val userId = challenge.optString("userId").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val registered = opaqueFinishRegistration(password, registration.state, challenge.getString("registrationResponse"))
        val made = com.hushos.core.accountCreate(userId, registered.exportKey)
        val sealed = made.envelope
        RecoveryWords.begun(userId)
        post(origin, "/api/auth/register/finish", JSONObject().put("name", name).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
            .put("recovery", json(made.recovery)).put("identity", json(made.identity))
            .put("workspace", JSONObject().put("id", made.workspaceId).put("grant", json(made.grant))), cookie)
        return userId
    }

    /*
     * Signs in and returns who signed in, for a caller with no step screen (a new account's first
     * sign-in): an account that asks for a second step is told to sign in from the app's own screen.
     */
    fun signIn(context: Context, origin: String, email: String, password: String): SessionUser =
        when (val result = startSignIn(context, origin, email, password)) {
            is SignIn.SignedIn -> result.user
            is SignIn.Step -> throw AuthFailure(StepWords.OPEN_APP)
        }

    /* Where a sign-in stands after the password: signed in, or stopped at the account's second step. */
    sealed class SignIn {
        data class SignedIn(val user: SessionUser) : SignIn()
        class Step(val pending: PendingSignIn) : SignIn()
    }

    /* Under SessionGuard: a removal wipe never runs while a sign-in stores its session, in any screen of the app. */
    fun startSignIn(context: Context, origin: String, email: String, password: String): SignIn =
        SessionGuard.signingIn { startSignInNow(context, origin, email, password) }

    /*
     * The password's half of a sign-in (docs/two-step-design.md 4). `twoStep: 1` says this build can
     * answer a second step; an account that has one gets no session, no cookie and no envelope here,
     * only the step, and what the password opened waits in `PendingSignIn` for the answer. The reply
     * is read whole by the core: one that is neither the session nor the step is a `LostReply`.
     */
    private fun startSignInNow(context: Context, origin: String, email: String, password: String): SignIn {
        val start = opaqueStartLogin(password)
        val started = post(origin, "/api/auth/login/start", JSONObject().put("email", email).put("startLoginRequest", start.request)).body
        val attemptToken = started.optString("attemptToken").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val loginResponse = started.optString("loginResponse").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val finish = opaqueFinishLogin(password, start.state, loginResponse) ?: throw AuthFailure(MISMATCH)
        val finishBody = JSONObject().put("attemptToken", attemptToken).put("finishLoginRequest", finish.request).put("twoStep", 1)
        // The device key's proof, only for the account it was made for: the same device comes back.
        deviceProof(Shared.deviceIdentity(context), email, attemptToken)?.let { finishBody.put("device", it) }
        val reply = send(origin, "/api/auth/login/finish", finishBody)
        return when (val read = signInReply(reply, StepWords.LOST_SIGN_IN)) {
            null -> SignIn.SignedIn(openSession(context, origin, email, finish.exportKey, reply))
            else -> SignIn.Step(PendingSignIn(origin, email, read, finish.exportKey))
        }
    }

    /*
     * What `login/finish` or `login/two-step` answered, as the core reads it: null for the session,
     * the step to answer, or a throw. A wrong password and the limiter's 429 are a sign-in's own
     * refusals, in the server's words as before; a step's refusal is a `StepRefused` with its code; a
     * reply that is not the server's answer is a `LostReply`, never a sign-in.
     */
    internal fun signInReply(reply: RawReply, lost: String, answering: Boolean = false): com.hushos.core.StepChallenge? =
        when (val read = com.hushos.core.signInReplyRead(reply.status.toUShort(), reply.text)) {
            is com.hushos.core.StepReply.Done -> null
            // Another step in place of the session is not what the step's own route answers.
            is com.hushos.core.StepReply.Step -> if (answering) throw LostReply(lost) else read.challenge
            is com.hushos.core.StepReply.Refused ->
                if (!answering && (read.refusal == com.hushos.core.StepRefusal.OTHER || read.refusal == com.hushos.core.StepRefusal.BUSY))
                    throw AuthFailure(Problems.signIn(reply.status, read.message), reply.status)
                else throw StepRefused(read.refusal, read.message, reply.status)
            is com.hushos.core.StepReply.Lost -> throw LostReply(lost)
        }

    /*
     * The step's answer: on a right one the server answers exactly what `login/finish` answers
     * without a step, and the envelope opens under what the password gave. A wrong answer, an ended
     * step and a lost reply are thrown; `StepOutcome` says what the screen does next.
     */
    fun answerStep(context: Context, pending: PendingSignIn, proof: com.hushos.core.StepProof): SessionUser = SessionGuard.signingIn {
        val reply = answerStepAt(pending.origin, pending.challenge.token, proof)
        openSession(context, pending.origin, pending.email, pending.exportKey, reply)
    }

    /* The request itself: the reply when it is the session's, a throw for anything else. */
    internal fun answerStepAt(origin: String, token: String, proof: com.hushos.core.StepProof): RawReply {
        val reply = send(origin, "/api/auth/login/two-step", StepAnswer(token, proof).json())
        signInReply(reply, StepWords.LOST_STEP, answering = true)
        return reply
    }

    /* The session's reply, whole (the core checked): the session and the device memory are stored, and the account returned. */
    private fun openSession(context: Context, origin: String, email: String, exportKey: ByteArray, finished: RawReply): SessionUser {
        val user = finished.body.optJSONObject("user")?.let(SessionUser::from) ?: throw AuthFailure("Signed in, but the session was not returned.")
        val envelopeJson = finished.body.optJSONObject("envelope") ?: throw AuthFailure("Signed in, but the session was not returned.")
        val token = finished.cookie ?: throw AuthFailure("Signed in, but the session was not returned.")
        // Another account's data on this phone goes before this one's session exists, and that account's session goes
        // first, so nothing still at work for it (a rollback mark) writes after the wipe.
        if (!AccountStore.of(context).owner().equals(user.id, ignoreCase = true)) Shared.clearSession(context)
        AccountStore.of(context).claim(user.id)
        Shared.writeOrigin(context, origin)
        Shared.writeSession(context, Shared.Session(origin, token, user.id, user.email))
        // A device the proof did not bring back describes itself and gets a key; a failure waits for the next launch.
        SessionDevice.from(finished.body.optJSONObject("device"))?.let { device ->
            runCatching { registerDevice(context, device, user.id, user.email.ifEmpty { email }) }
        }
        val envelope = AccountKeyEnvelope(
            envelopeJson.getInt("envelopeVersion").toUInt(), envelopeJson.getLong("keyVersion").toULong(), envelopeJson.getLong("credentialVersion").toULong(),
            envelopeJson.getString("wrappingSalt"), envelopeJson.getString("wrappingNonce"), envelopeJson.getString("encryptedKey"),
        )
        val existing = Shared.device(context)
        if (existing != null && existing.bundle.userId.equals(user.id, ignoreCase = true) && existing.bundle.credentialVersion == envelope.credentialVersion) return user
        val accountKey = accountUnlock(user.id, exportKey, envelope)
        val memory = deviceRemember(user.id, accountKey, envelope.keyVersion, envelope.credentialVersion, UUID.randomUUID().toString())
        Shared.writeDevice(context, memory)
        return user
    }

    /*
     * The sign-in that follows a phrase reset. An account with two-step sign-in (docs/two-step-design.md
     * 4, 5) is asked for its step there, and the recovery phrase passes it: the account's phrase is now
     * `freshPhrase`, just made on this phone, which the person has not seen yet. It answers, so a person
     * with only their phrase is not asked for a method they may have lost.
     */
    fun signInAfterRecovery(context: Context, origin: String, email: String, password: String, freshPhrase: String): SessionUser =
        when (val result = startSignIn(context, origin, email, password)) {
            is SignIn.SignedIn -> result.user
            is SignIn.Step -> {
                val challenge = result.pending.challenge
                val signing = challenge.phrase?.takeIf { com.hushos.core.StepMethod.PHRASE in challenge.methods } ?: throw AuthFailure(StepWords.CANNOT_ANSWER)
                val signature = com.hushos.core.twoStepPhraseSign(freshPhrase, signing.wrappingSalt, signing.userId, challenge.token)
                answerStep(context, result.pending, com.hushos.core.StepProof.Phrase(signature))
            }
        }

    /*
     * The device key's proof for `attemptToken`, when `identity` was made for the email being signed
     * in with; null otherwise, so a phone shared by two people never tells the server that one
     * person's device is signing in as the other.
     */
    internal fun deviceProof(identity: Shared.DeviceIdentity?, email: String, attemptToken: String): JSONObject? {
        if (identity == null || identity.emailHash != deviceEmailHash(email)) return null
        val signature = runCatching { deviceSessionSign(identity.seed, identity.userId, identity.deviceId, attemptToken) }.getOrNull() ?: return null
        return JSONObject().put("id", identity.deviceId).put("signature", signature)
    }

    /* Whether this device is a tablet, by its smallest screen width, as the device list words it. */
    fun isTablet(context: Context): Boolean = context.resources.configuration.smallestScreenWidthDp >= 600

    /* The name a new device record gets: maker and model ("Pixel 9", "Samsung SM-S931B"), see DeviceName. The person can rename it. */
    fun deviceName(context: Context): String = DeviceName.of(android.os.Build.MANUFACTURER, android.os.Build.MODEL, isTablet(context))

    /* Registers the session's device with a new key when it has not described itself yet, and keeps the key. */
    fun registerDevice(context: Context, device: SessionDevice, userId: String, email: String) {
        if (device.registered) return
        val key = deviceSigningCreate()
        val registered = call(context, "/api/auth/devices", JSONObject().put("kind", "android").put("name", deviceName(context))
            .put("signingPublicKey", com.hushos.core.base64urlEncode(key.publicKey))).getJSONObject("device")
        Shared.writeDeviceIdentity(context, Shared.DeviceIdentity(userId, deviceEmailHash(email), registered.getString("id"), key.seed))
    }

    /* The account's devices, this one first. */
    fun devices(context: Context): List<AccountDevice> {
        val list = call(context, "/api/auth/devices").optJSONArray("devices") ?: return emptyList()
        return (0 until list.length()).map { AccountDevice.from(list.getJSONObject(it)) }
    }

    /* PUT, not PATCH: HttpURLConnection refuses PATCH. */
    fun renameDevice(context: Context, id: String, name: String): AccountDevice =
        AccountDevice.from(call(context, "/api/auth/devices/$id", JSONObject().put("name", name), "PUT").getJSONObject("device"))

    /*
     * One password re-check at a time on this phone. Each one is an OPAQUE exchange bound to the session,
     * then the change it authorises (a new password, a rotation, deleting the account, removing devices,
     * a change to the step). Turning the step on leaves one running behind the backup codes (the removal
     * of the other devices) while the person is free to start another: taken in turn, the second starts
     * only once the first has finished, under the session the first left. Fair, so they go in the order asked.
     */
    private val passwordLock = java.util.concurrent.locks.ReentrantLock(true)
    internal fun <T> passwordTurn(block: () -> T): T {
        passwordLock.lock()
        try { return block() } finally { passwordLock.unlock() }
    }

    /*
     * Removing devices proves the password again (OPAQUE in the core, bound to this session), so a
     * session alone cannot sign the other devices out and have them clear what they kept.
     */
    private fun passwordProof(context: Context, password: String): JSONObject {
        val login = opaqueStartLogin(password)
        val started = call(context, "/api/auth/devices/reauth", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse"))
            ?: throw AuthFailure("That password isn’t right. Check it and try again.")
        return JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request)
    }

    /* Signs another device out at once; the server refuses this phone (sign out instead). */
    fun removeDevice(context: Context, id: String, password: String) {
        passwordTurn { call(context, "/api/auth/devices/$id", passwordProof(context, password), "DELETE") }
    }

    fun removeOtherDevices(context: Context, password: String): Int =
        passwordTurn { call(context, "/api/auth/devices/others", passwordProof(context, password), "DELETE").optInt("removed") }

    /*
     * Whether a late "removed" answer about `ended` may still clear the phone: only while nobody has
     * signed in since (no session stored) and what the phone holds is still that account's. The check
     * runs in the background after sign-in is on screen; whoever signed in meanwhile keeps their data.
     */
    fun mayForgetRemoved(ended: Shared.Session, current: Shared.Session?, owner: String?): Boolean =
        current == null && owner != null && owner.equals(ended.userId, ignoreCase = true)

    /*
     * What the server says about `session` (the stored one by default); throws when HushOS is unreachable, and
     * SessionUnavailable on any answer but 200. The server answers every session, dead or removed included, with
     * 200, so anything else came from something in the way (an error on its side, a deploy, a proxy): callers keep
     * the stored session as if offline, as the web does.
     */
    fun sessionCheck(context: Context, session: Shared.Session? = Shared.session(context)): SessionCheck =
        session?.let { sessionCheckAt(it) } ?: SessionCheck.Ended

    internal fun sessionCheckAt(session: Shared.Session): SessionCheck {
        val connection = URL(session.origin + "/api/auth/session").openConnection() as HttpURLConnection
        val cookieName = if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
        connection.setRequestProperty("Cookie", "$cookieName=${session.token}")
        connection.setRequestProperty("Origin", session.origin)
        connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
        connection.connectTimeout = 20_000
        connection.readTimeout = 20_000
        val status = connection.responseCode
        if (status != 200) throw SessionUnavailable(status)
        return SessionCheck.from(JSONObject(connection.inputStream.bufferedReader().use { it.readText() }))
    }

    /* Who the stored session belongs to, null when it is gone; throws when HushOS is unreachable. */
    fun currentUser(context: Context): SessionUser? = (sessionCheck(context) as? SessionCheck.SignedIn)?.user

    private fun cookie(session: Shared.Session) =
        (if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session") + "=" + session.token

    /* `as` names the session to send: a vault's own, so what it writes never goes out under another account's. */
    private fun call(context: Context, path: String, body: JSONObject? = null, method: String? = null, `as`: Shared.Session? = null, whole: Boolean = false, lost: String = StepWords.LOST_CHANGE): JSONObject =
        callAt(`as` ?: Shared.session(context) ?: throw AuthFailure("Sign in first."), path, body, method, whole, lost)

    /* A reply under a session, as it arrived. */
    internal class SessionReply(val status: Int, val text: String, val body: JSONObject)

    /* Sends under `session` and returns whatever came back, any status; throws only when nothing did. */
    internal fun requestAt(session: Shared.Session, path: String, body: JSONObject? = null, method: String? = null): SessionReply {
        val connection = URL(session.origin + path).openConnection() as HttpURLConnection
        connection.requestMethod = method ?: if (body == null) "GET" else "POST"
        connection.setRequestProperty("Cookie", cookie(session))
        connection.setRequestProperty("Origin", session.origin)
        connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        val status: Int
        val text: String
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw AuthUnreachable()
        }
        return SessionReply(status, text, runCatching { JSONObject(text) }.getOrDefault(JSONObject()))
    }

    /*
     * `whole` is for a change that may carry a second step: its 200 must be the server's own JSON
     * object, or the reply is lost (`LostReply`) and nothing says whether the change went through; so
     * is a 5xx that does not name `step-unavailable`. A refusal that names one of the step's codes is
     * thrown as `StepRefused` from any route, in the server's words; a bare 429 stays the route's own.
     */
    internal fun callAt(session: Shared.Session, path: String, body: JSONObject? = null, method: String? = null, whole: Boolean = false, lost: String = StepWords.LOST_CHANGE): JSONObject {
        val reply = requestAt(session, path, body, method)
        if (reply.status !in 200..299) {
            val read = com.hushos.core.stepChangeReplyRead(reply.status.toUShort(), reply.text)
            if (read is com.hushos.core.StepReply.Refused && stepNamed(read.refusal)) throw StepRefused(read.refusal, read.message, reply.status)
            // A server error without the step's code (a 503 from something in the way): the change may have gone through.
            if (whole && read is com.hushos.core.StepReply.Lost && reply.status >= 500) throw LostReply(lost)
            if (reply.status == 401) throw NotAuthenticated()
            throw AuthFailure(Problems.signIn(reply.status, reply.body.optString("message")), reply.status)
        }
        if (whole && com.hushos.core.stepChangeReplyRead(reply.status.toUShort(), reply.text) !is com.hushos.core.StepReply.Done) throw LostReply(lost)
        return reply.body
    }

    /* Thrown as the step's own refusal: when the server named one of its codes. The address's own 429 and anything else stay the route's error. */
    /*
     * A security change or a deletion the server says it made: `{ "success": true }`, as the web's
     * `readDone` reads it. Any other 200 says nothing either way, and is a lost reply.
     */
    internal fun done(reply: JSONObject, lost: String) {
        if (reply.opt("success") != true) throw LostReply(lost)
    }

    private fun stepNamed(refusal: com.hushos.core.StepRefusal): Boolean = when (refusal) {
        com.hushos.core.StepRefusal.BUSY, com.hushos.core.StepRefusal.OTHER -> false
        else -> true
    }

    /* The identity envelope the server keeps for this account. */
    fun identity(context: Context, `as`: Shared.Session? = null): com.hushos.core.IdentityEnvelope =
        identityEnvelope(call(context, "/api/auth/identity", `as` = `as`).getJSONObject("identity"))

    /* The account's earlier identities, oldest first, still sealed under the root: shares sealed to earlier keys open only with them. */
    fun identityHistory(context: Context, `as`: Shared.Session? = null): List<com.hushos.core.IdentityEnvelope> {
        val list = call(context, "/api/auth/identity/history", `as` = `as`).optJSONArray("identities") ?: return emptyList()
        return (0 until list.length()).map { identityEnvelope(list.getJSONObject(it)) }
    }

    /* Stores the next identity, vouched for by the current signing key; the server keeps the current one in the history. */
    fun succeedIdentity(context: Context, succession: com.hushos.core.IdentitySuccession, `as`: Shared.Session? = null) {
        call(context, "/api/auth/identity/succession", JSONObject().put("identity", json(succession.identity)).put("signature", succession.signature), `as` = `as`)
    }

    /*
     * The upgrade of a version 1 identity to version 2 (the same X25519, Ed25519 and ML-KEM keys and key version, plus
     * ML-DSA and the keys statement); returns the identity the server stored. A 409 (`status`) means another device
     * upgraded first: read the identity again and open that one.
     */
    fun upgradeIdentity(context: Context, identity: com.hushos.core.IdentityEnvelope, `as`: Shared.Session? = null): com.hushos.core.IdentityEnvelope =
        identityEnvelope(call(context, "/api/auth/identity/upgrade", JSONObject().put("identity", json(identity)), `as` = `as`).getJSONObject("identity"))

    /*
     * A contact's whole succession chain (version 2 links only), in order, for the device to check link by link. Asked from the first version
     * whatever the pin holds, so the request does not say which version this device pinned.
     */
    fun succession(context: Context, userId: String, `as`: Shared.Session? = null): List<com.hushos.core.SuccessionLink> {
        val links = call(context, "/api/auth/contacts/${java.net.URLEncoder.encode(userId, "UTF-8")}/succession?from=$CHAIN_FROM", `as` = `as`).optJSONArray("links") ?: return emptyList()
        return (0 until links.length()).map { index ->
            val link = links.getJSONObject(index)
            com.hushos.core.SuccessionLink(
                link.getLong("oldKeyVersion").toULong(), link.getLong("newKeyVersion").toULong(),
                link.getString("oldEncryptionPublicKey"), link.getString("oldSigningPublicKey"), link.getString("oldMlDsaPublicKey"),
                link.getString("newEncryptionPublicKey"), link.getString("newSigningPublicKey"), link.getString("newMlDsaPublicKey"),
                link.getString("newKemPublicKey"), link.getString("signature"),
            )
        }
    }

    /* An identity envelope as served: version 1 (a KEM binding at most) or 2 (ML-DSA and the keys statement). */
    internal fun identityEnvelope(json: JSONObject): com.hushos.core.IdentityEnvelope {
        fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }
        val kem = json.optJSONObject("kem")?.let { com.hushos.core.IdentityKem(it.getString("publicKey"), it.getString("seedNonce"), it.getString("encryptedSeed"), it.text("signature")) }
        val mlDsa = json.optJSONObject("mlDsa")?.let { com.hushos.core.IdentityMlDsa(it.getString("publicKey"), it.getString("seedNonce"), it.getString("encryptedSeed")) }
        return com.hushos.core.IdentityEnvelope(
            json.getInt("version").toUInt(), json.getLong("keyVersion").toULong(), json.getString("wrappingSalt"),
            json.getString("encryptionPublicKey"), json.getString("encryptionPrivateKeyNonce"), json.getString("encryptedEncryptionPrivateKey"),
            json.getString("signingPublicKey"), json.getString("signingSeedNonce"), json.getString("encryptedSigningSeed"), kem,
            mlDsa, json.text("keysSignature"),
        )
    }

    /*
     * The wire form the server's schema takes: version 2 with its ML-DSA half and keys signature and a KEM half without
     * a binding; version 1 (only ever rewrapped, in the history) with its KEM binding when it has one.
     */
    internal fun json(identity: com.hushos.core.IdentityEnvelope): JSONObject {
        val out = JSONObject()
            .put("version", identity.version.toInt()).put("keyVersion", identity.keyVersion.toLong()).put("wrappingSalt", identity.wrappingSalt)
            .put("encryptionPublicKey", identity.encryptionPublicKey).put("encryptionPrivateKeyNonce", identity.encryptionPrivateKeyNonce)
            .put("encryptedEncryptionPrivateKey", identity.encryptedEncryptionPrivateKey).put("signingPublicKey", identity.signingPublicKey)
            .put("signingSeedNonce", identity.signingSeedNonce).put("encryptedSigningSeed", identity.encryptedSigningSeed)
        val kem = identity.kem?.let { kem ->
            JSONObject().put("publicKey", kem.publicKey).put("seedNonce", kem.seedNonce).put("encryptedSeed", kem.encryptedSeed)
                .also { if (identity.version == 1u && kem.signature != null) it.put("signature", kem.signature) }
        }
        out.put("kem", kem ?: JSONObject.NULL)
        if (identity.version >= 2u) {
            identity.mlDsa?.let { out.put("mlDsa", JSONObject().put("publicKey", it.publicKey).put("seedNonce", it.seedNonce).put("encryptedSeed", it.encryptedSeed)) }
            identity.keysSignature?.let { out.put("keysSignature", it) }
        }
        return out
    }

    private fun recoveryEnvelope(json: JSONObject) = com.hushos.core.RecoveryEnvelope(
        json.getInt("version").toUInt(), json.getLong("keyVersion").toULong(), json.getLong("recoveryVersion").toULong(),
        json.getString("wrappingSalt"), json.getString("wrappingNonce"), json.getString("encryptedKey"),
        json.getString("backupNonce"), json.getString("encryptedRecoveryKey"), json.getString("publicKey"),
    )

    private fun json(recovery: com.hushos.core.RecoveryEnvelope): JSONObject = JSONObject()
        .put("version", recovery.version.toInt()).put("keyVersion", recovery.keyVersion.toLong()).put("recoveryVersion", recovery.recoveryVersion.toLong())
        .put("wrappingSalt", recovery.wrappingSalt).put("wrappingNonce", recovery.wrappingNonce).put("encryptedKey", recovery.encryptedKey)
        .put("backupNonce", recovery.backupNonce).put("encryptedRecoveryKey", recovery.encryptedRecoveryKey).put("publicKey", recovery.publicKey)

    private fun json(grant: com.hushos.core.WorkspaceGrant): JSONObject = JSONObject()
        .put("version", grant.version.toInt()).put("workspaceId", grant.workspaceId).put("keyVersion", grant.keyVersion.toLong())
        .put("workspaceKeyVersion", grant.workspaceKeyVersion.toLong()).put("wrappingSalt", grant.wrappingSalt)
        .put("wrappingNonce", grant.wrappingNonce).put("encryptedKey", grant.encryptedKey)

    /* A person by email, with their identity's public keys. The address goes in the body, never the URL a log keeps. */
    fun lookupContact(context: Context, email: String, `as`: Shared.Session? = null): Contact {
        val json = call(context, "/api/auth/contacts/lookup", JSONObject().put("email", email), `as` = `as`).optJSONObject("contact")
            ?: throw AuthFailure("No HushOS account uses that email.")
        return Contact(json.getString("userId"), json.optString("name"), json.optString("email", email), ServedIdentity.from(json))
    }

    /* The settings as stored, and the settings key wrapped under the root (null until a device stored one). */
    /*
     * `sequence`: the stored settings sequence, served even when `envelope` is null (0 for no row; above 0 for a
     * version 1 row, which is served as none). The next save names it as expectedVersion and seals at one above.
     */
    data class StoredSettings(val envelope: com.hushos.core.SettingsEnvelope?, val key: com.hushos.core.SettingsKeyEnvelope?, val sequence: ULong = envelope?.settingsVersion ?: 0uL)

    fun settings(context: Context, `as`: Shared.Session? = null): StoredSettings = call(context, "/api/auth/settings", `as` = `as`).let { body ->
        val envelope = body.optJSONObject("settings")?.let(::settingsEnvelope)
        StoredSettings(envelope,
            body.optJSONObject("settingsKey")?.let { com.hushos.core.SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext")) },
            body.optLong("settingsVersion", -1L).takeIf { it >= 0 }?.toULong() ?: envelope?.settingsVersion ?: 0uL)
    }

    /* Stores the wrapped settings key once; a 409 means another device stored one first (read it and use that). */
    fun putSettingsKey(context: Context, envelope: com.hushos.core.SettingsKeyEnvelope, `as`: Shared.Session? = null) {
        call(context, "/api/auth/settings-key", json(envelope), "PUT", `as`)
    }

    /* Saves the envelope over `expectedVersion`, as its own envelope version; returns the version the server now holds. */
    fun putSettings(context: Context, expectedVersion: ULong, envelope: com.hushos.core.SettingsEnvelope, `as`: Shared.Session? = null): ULong =
        call(context, "/api/auth/settings", JSONObject().put("expectedVersion", expectedVersion.toLong()).put("version", envelope.version.toInt())
            .put("nonce", envelope.nonce).put("ciphertext", envelope.ciphertext), "PUT", `as`)
            .optLong("settingsVersion", envelope.settingsVersion.toLong()).toULong()

    private fun json(key: com.hushos.core.SettingsKeyEnvelope): JSONObject = JSONObject().put("nonce", key.nonce).put("ciphertext", key.ciphertext)

    /* The recovery key envelope the server keeps. */
    fun recoveryKey(context: Context): com.hushos.core.RecoveryEnvelope =
        recoveryEnvelope(call(context, "/api/auth/recovery-key").optJSONObject("recovery") ?: throw NoRecoveryKey())

    /*
     * Rotates the master key, as the web's "Rotate keys" does: a fresh account
     * key replaces the old one under the same password, the identity (and every
     * earlier one), the settings key and every workspace grant are sealed again
     * under it, and a new recovery phrase is
     * minted. The server ends every session, so the caller signs in again.
     * Returns the phrase to show once.
     */
    fun rotateKeys(context: Context, password: String, twoStep: StepAnswer? = null): String = rotateKeysKit(context, password, twoStep).first

    /*
     * The same, with the new recovery key as the server now holds it: what the kit file carries. An
     * account with two-step sign-in has no session to read it back with until it has signed in again,
     * and the kit is saved before that.
     */
    fun rotateKeysKit(context: Context, password: String, twoStep: StepAnswer? = null): Pair<String, JSONObject> = passwordTurn { rotateKeysNow(context, password, twoStep) }

    private fun rotateKeysNow(context: Context, password: String, twoStep: StepAnswer?): Pair<String, JSONObject> {
        val login = opaqueStartLogin(password)
        val registration = opaqueStartRegistration(password)
        val challenge = call(context, "/api/auth/security/start", JSONObject().put("action", "master-key")
            .put("startLoginRequest", login.request).put("registrationRequest", registration.request))
        val finish = opaqueFinishLogin(password, login.state, challenge.getString("loginResponse")) ?: throw AuthFailure("The password is not right.")
        val userId = challenge.getString("userId")
        val old = envelope(challenge.getJSONObject("envelope"))
        val oldRoot = accountUnlock(userId, finish.exportKey, old)
        val newRoot = com.hushos.core.randomBytes(32u)
        val keyVersion = old.keyVersion + 1uL
        val registered = opaqueFinishRegistration(password, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, newRoot, keyVersion, old.credentialVersion + 1uL)
        val oldRecovery = recoveryEnvelope(challenge.getJSONObject("recovery"))
        val recovery = com.hushos.core.recoveryCreate(userId, newRoot, oldRecovery.recoveryVersion + 1uL, keyVersion)
        // The identity keeps its own version (it counts generations, not roots); every earlier one comes along, in order,
        // or shares sealed to it would die with the old root. The settings key too, when there is one.
        val identity = com.hushos.core.identityRewrap(userId, oldRoot, newRoot, identityEnvelope(challenge.getJSONObject("identity")))
        val history = JSONArray()
        challenge.optJSONArray("identityHistory")?.let { earlier ->
            for (index in 0 until earlier.length()) history.put(json(com.hushos.core.identityRewrap(userId, oldRoot, newRoot, identityEnvelope(earlier.getJSONObject(index)))))
        }
        val settingsKey = challenge.optJSONObject("settingsKey")?.let {
            com.hushos.core.settingsKeyRewrap(userId, oldRoot, newRoot, com.hushos.core.SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext")))
        }
        val workspaces = rewrapGrants(challenge.getJSONArray("workspaces"), userId, oldRoot, newRoot, keyVersion)
        call(context, "/api/auth/security/finish", JSONObject().put("action", "master-key").put("attemptToken", challenge.getString("attemptToken"))
            .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
            .put("recovery", json(recovery.envelope)).put("identity", json(identity)).put("workspaces", workspaces)
            .put("identityHistory", history).apply { settingsKey?.let { put("settingsKey", json(it)) } }
            .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_SAVED).let { done(it, StepWords.LOST_SAVED) }
        Shared.writeDevice(context, deviceRemember(userId, newRoot, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString()))
        return recovery.phrase to json(recovery.envelope)
    }

    /*
     * Every grant a rotation's challenge serves, under the new root. A family folder's self-grant opens only as its
     * family's, so it is rewrapped as one: the server names the family (`groupId`), and a wrong or missing one makes
     * the core refuse, never guess.
     */
    internal fun rewrapGrants(grants: JSONArray, userId: String, oldRoot: ByteArray, newRoot: ByteArray, keyVersion: ULong): JSONArray {
        val out = JSONArray()
        for (index in 0 until grants.length()) {
            val g = grants.getJSONObject(index)
            val grant = com.hushos.core.WorkspaceGrant(g.getInt("version").toUInt(), g.getString("workspaceId"), g.getLong("keyVersion").toULong(),
                g.getLong("workspaceKeyVersion").toULong(), g.getString("wrappingSalt"), g.getString("wrappingNonce"), g.getString("encryptedKey"))
            val groupId = if (g.isNull("groupId")) null else g.getString("groupId")
            out.put(json(
                if (groupId != null) com.hushos.core.areaSelfGrantRewrap(userId, groupId, oldRoot, newRoot, grant, keyVersion)
                else com.hushos.core.workspaceGrantRewrap(userId, oldRoot, newRoot, grant, keyVersion),
            ))
        }
        return out
    }

    fun updateName(context: Context, name: String): SessionUser =
        call(context, "/api/auth/profile", JSONObject().put("name", name)).optJSONObject("user")?.let(SessionUser::from)
            ?: throw AuthFailure("HushOS returned no account.")

    /* The recovery key as the server keeps it (for the kit file) and whether its phrase was confirmed as saved. */
    fun recoveryBackup(context: Context): Pair<JSONObject, Boolean> = call(context, "/api/auth/recovery-key").let {
        (it.optJSONObject("recovery") ?: throw NoRecoveryKey()) to it.optBoolean("confirmed")
    }

    /* Marks the phrase as saved, as the web does after its check; the server refuses an older phrase's version. */
    fun confirmRecovery(context: Context, recoveryVersion: Long) {
        call(context, "/api/auth/recovery-key/confirm", JSONObject().put("recoveryVersion", recoveryVersion))
    }

    fun storage(context: Context): StorageAllowance = StorageAllowance.from(call(context, "/api/auth/storage").getJSONObject("storage"))

    fun billing(context: Context): BillingSummary = BillingSummary.from(call(context, "/api/billing"))

    /* A family's plan as this member may see it (FamilyPlan); `groupId` a lowercase UUID, checked by the caller. */
    fun familyBilling(context: Context, groupId: String, session: Shared.Session): JSONObject = call(context, "/api/billing/groups/$groupId", `as` = session)

    private fun envelope(json: JSONObject) = AccountKeyEnvelope(
        json.getInt("envelopeVersion").toUInt(), json.getLong("keyVersion").toULong(), json.getLong("credentialVersion").toULong(),
        json.getString("wrappingSalt"), json.getString("wrappingNonce"), json.getString("encryptedKey"),
    )

    /*
     * The old password opens the account key; the new one seals it again one credential version up.
     * `twoStep` is the second step's answer, for an account that has it on: without one the server
     * refuses with `two-step` (`StepRefused`) and nothing changes. No replacement session is asked for
     * (`keepSession`): this phone signs in again, and is asked for the step.
     */
    fun changePassword(context: Context, current: String, new: String, twoStep: StepAnswer? = null) = passwordTurn { changePasswordNow(context, current, new, twoStep) }

    private fun changePasswordNow(context: Context, current: String, new: String, twoStep: StepAnswer?) {
        val login = opaqueStartLogin(current)
        val registration = opaqueStartRegistration(new)
        val challenge = call(context, "/api/auth/security/start", JSONObject().put("action", "password")
            .put("startLoginRequest", login.request).put("registrationRequest", registration.request))
        val finish = opaqueFinishLogin(current, login.state, challenge.getString("loginResponse")) ?: throw AuthFailure("The current password is not right.")
        val userId = challenge.getString("userId")
        val old = envelope(challenge.getJSONObject("envelope"))
        val accountKey = accountUnlock(userId, finish.exportKey, old)
        val registered = opaqueFinishRegistration(new, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, accountKey, old.keyVersion, old.credentialVersion + 1uL)
        call(context, "/api/auth/security/finish", JSONObject().put("action", "password").put("attemptToken", challenge.getString("attemptToken"))
            .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
            .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_SAVED).let { done(it, StepWords.LOST_SAVED) }
        Shared.writeDevice(context, deviceRemember(userId, accountKey, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString()))
    }

    /* Proves the password once more, then the server removes the account; every local trace goes with it. */
    fun deleteAccount(context: Context, password: String, twoStep: StepAnswer? = null) = passwordTurn { deleteAccountNow(context, password, twoStep) }

    private fun deleteAccountNow(context: Context, password: String, twoStep: StepAnswer?) {
        val login = opaqueStartLogin(password)
        val started = call(context, "/api/auth/delete/start", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse")) ?: throw AuthFailure("The password is not right.")
        call(context, "/api/auth/delete/finish", JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request)
            .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_DELETED).let { done(it, StepWords.LOST_DELETED) }
        Shared.clearSession(context)
        Shared.clearDevice(context)
        AccountStore.of(context).wipe()
    }

    /* Ends the session on the server, then removes it, the remembered account key and every file of the account from this phone. */
    fun signOut(context: Context) {
        Shared.session(context)?.let { session ->
            val cookieName = if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
            runCatching { post(session.origin, "/api/auth/logout", JSONObject(), "$cookieName=${session.token}") }
        }
        Shared.clearSession(context)
        Shared.clearDevice(context)
        // Signing out removes this device on the server; its key goes too, so the next sign-in is a new device.
        Shared.clearDeviceIdentity(context)
        AccountStore.of(context).wipe()
    }

    /*
     * The server says this phone was removed from the account: everything of the account on the phone
     * goes, as on sign-out, without asking the server for anything more. Housekeeping, not a guarantee.
     */
    fun forgetRemoved(context: Context) {
        Shared.clearSession(context)
        Shared.clearDevice(context)
        Shared.clearDeviceIdentity(context)
        AccountStore.of(context).wipe()
    }
}
