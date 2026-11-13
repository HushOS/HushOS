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

/* The password did not open what the server holds for the account: told apart by its type where that decides something (a reset's proof). */
class WrongPassword : AuthFailure(Auth.MISMATCH)

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

    const val PHRASE_REFUSED = "These words didn’t open your account. Check you used your newest kit."
    const val PHRASE_UNCHECKED = "These words couldn’t be checked. Check you used your newest kit, then try again."

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

    /*
     * The account a recovery opened, and its new phrase with the recovery key for the kit file. `user` is
     * null when the sign-in after the reset didn't happen: the words are shown all the same, and the person
     * signs in after them. `certain` is false when nothing says the reset was made (its reply was lost and
     * so was the sign-in's): the words are shown, and said to be kept beside the old ones.
     */
    class Recovered(val userId: String, val email: String, val user: SessionUser?, val phrase: String, val recovery: JSONObject, val recoveryVersion: Long, val certain: Boolean)

    /*
     * Resets the password with the phrase, then signs in with the new one. Once `recover/finish` has been
     * sent and not refused the new phrase is returned whatever happens next (Reset): the old one may be
     * dead already, and the new one exists only here. `sent` runs then, before any session is stored, with
     * the account's id: the caller marks the words as waiting.
     */
    fun recover(context: Context, origin: String, enrollment: RecoveryEnrollment, phrase: String, password: String, sent: (String) -> Unit = {}): Recovered {
        val made = resetNow(origin, enrollment, phrase, password)
        // Refused: nothing changed, and nothing is tried with the new password. Otherwise the sign-in is tried
        // (twice at most). When the reset's own reply was lost, that sign-in is also what says whether it was made.
        var proved: Reset.Proved = Reset.Proved.Unknown
        if (made.sent !is Reset.Sent.Refused) {
            sent(made.userId)
            proved = Reset.prove { proveReset(context, origin, enrollment.email, password, made) }
        }
        return when (val settled = Reset.settle(made.sent, proved, StepWords.NOT_RESET)) {
            is Reset.Settled.Refused -> throw AuthFailure(settled.said)
            is Reset.Settled.Show -> Recovered(made.userId, enrollment.email, settled.user, made.phrase, made.recovery, made.recovery.getLong("recoveryVersion"), settled.certain)
        }
    }

    /*
     * A change that replaces the recovery phrase (a reset, a rotation), once its last request has gone out: the new
     * phrase, what that request answered, and the versions the change writes, which a later reply shows only if it
     * was made. `memory`: what this phone remembers once it is known to have been made (a rotation's new root).
     */
    internal class ResetMade(val userId: String, val phrase: String, val recovery: JSONObject, val sent: Reset.Sent, val credentialVersion: ULong, val recoveryVersion: ULong,
        val memory: com.hushos.core.DeviceMemory? = null)

    /* The reset itself, up to and including `recover/finish`, and what that answered. Anything before it that fails is thrown: nothing was changed. */
    internal fun resetNow(origin: String, enrollment: RecoveryEnrollment, phrase: String, password: String): ResetMade {
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
        // From here the server may have taken the reset whatever comes back, or nothing does: never thrown, only read.
        val sent = try {
            val reply = send(origin, "/api/auth/recover/finish", JSONObject().put("userId", userId).put("attemptToken", attempt)
                .put("credentialVersion", credentialVersion.toLong()).put("registrationRecord", registered.record)
                .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                    .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                    .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
                .put("recovery", json(next.envelope)).put("signature", signature), cookie)
            Reset.sent(reply.status, reply.body)
        } catch (error: AuthFailure) {
            Reset.Sent.Unknown
        }
        return ResetMade(userId, next.phrase, json(next.envelope), sent, sealed.credentialVersion, next.envelope.recoveryVersion)
    }

    /*
     * One sign-in with the new password, and what it shows about the reset. Signing in is not the evidence:
     * someone who reset to the password they already had signs in against the unchanged account. The
     * versions are: the session's envelope is sealed at the reset's credential version only if the reset
     * was made, and a second step names the reset's recovery key only then.
     *
     * - Made: the session is opened; or the step (docs/two-step-design.md 4, 5) is answered with the phrase
     *   just made here, which the person has not seen yet, so someone with only their phrase is not asked
     *   for a method they may have lost. A step that does not pass still shows the reset was made.
     * - Not made (an old version, or the new password refused): the probe's session is ended and never
     *   stored, and a step that names the old recovery key is not answered, so no wrong answer is counted.
     * - No reply shows a version: unknown.
     */
    private fun proveReset(context: Context, origin: String, email: String, password: String, made: ResetMade): Reset.Proved = SessionGuard.signingIn {
        proved(
            probe = {
                when (val met = passwordHalf(context, origin, email, password)) {
                    is Met.Step -> Probe.Step(met.pending)
                    is Met.Session -> Probe.Session(
                        met.reply.body.optJSONObject("envelope")?.takeIf { it.has("credentialVersion") }?.optLong("credentialVersion")?.toULong(),
                        open = { openSession(context, origin, email, met.exportKey, met.reply) },
                        end = { met.reply.cookie?.let { endSession(origin, it) } },
                    )
                }
            },
            answer = { pending, proof -> answerStep(context, pending, proof) },
            credentialVersion = made.credentialVersion, recoveryVersion = made.recoveryVersion, freshPhrase = made.phrase,
        )
    }

    /* What the sign-in with the new password met: a session not yet stored (with the version its envelope is sealed at), or the step. */
    internal sealed class Probe {
        class Session(val credentialVersion: ULong?, val open: () -> SessionUser, val end: () -> Unit) : Probe()
        class Step(val pending: PendingSignIn) : Probe()
    }

    /* The rule above, over a sign-in and a step's answer the caller supplies, so every way it can end is tested. */
    internal fun proved(probe: () -> Probe, answer: (PendingSignIn, com.hushos.core.StepProof) -> SessionUser, credentialVersion: ULong, recoveryVersion: ULong, freshPhrase: String): Reset.Proved {
        val met = try {
            probe()
        } catch (error: WrongPassword) {
            return Reset.Proved.NotApplied
        } catch (error: Exception) {
            // No answer, a limit, or the session's own reply gone missing: nothing shows a version.
            return Reset.Proved.Unknown
        }
        return when (met) {
            is Probe.Session -> when (met.credentialVersion) {
                credentialVersion -> runCatching { Reset.Proved.SignedIn(met.open()) }.getOrDefault(Reset.Proved.Applied)
                // The envelope the reset would have replaced: the password signs in because it was the password already.
                // Any other version says nothing of this reset. Either way the session was only asked for to look: ended, never stored.
                else -> { runCatching { met.end() }; if (met.credentialVersion == credentialVersion - 1uL) Reset.Proved.NotApplied else Reset.Proved.Unknown }
            }
            is Probe.Step -> {
                val challenge = met.pending.challenge
                val signing = challenge.phrase ?: return Reset.Proved.Unknown
                when (signing.recoveryVersion) {
                    recoveryVersion -> {
                        if (com.hushos.core.StepMethod.PHRASE !in challenge.methods) return Reset.Proved.Applied
                        runCatching {
                            Reset.Proved.SignedIn(answer(met.pending, com.hushos.core.StepProof.Phrase(com.hushos.core.twoStepPhraseSign(freshPhrase, signing.wrappingSalt, signing.userId, challenge.token))))
                        }.getOrDefault(Reset.Proved.Applied)
                    }
                    // The old recovery key: the new phrase would be a wrong answer, and is not sent.
                    recoveryVersion - 1uL -> Reset.Proved.NotApplied
                    else -> Reset.Proved.Unknown
                }
            }
        }
    }

    /* Ends a session by its cookie's token alone, touching nothing this phone has stored. Best effort: it runs out by itself otherwise. */
    private fun endSession(origin: String, token: String) {
        val cookieName = if (origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
        runCatching { send(origin, "/api/auth/logout", JSONObject(), "$cookieName=$token") }
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
    private fun startSignInNow(context: Context, origin: String, email: String, password: String): SignIn =
        when (val met = passwordHalf(context, origin, email, password)) {
            is Met.Session -> SignIn.SignedIn(openSession(context, origin, email, met.exportKey, met.reply))
            is Met.Step -> SignIn.Step(met.pending)
        }

    /* What the password's half met, with nothing stored yet: the session's reply (whole, with its cookie), or the step. */
    private sealed class Met {
        class Session(val reply: RawReply, val exportKey: ByteArray) : Met()
        class Step(val pending: PendingSignIn) : Met()
    }

    private fun passwordHalf(context: Context, origin: String, email: String, password: String): Met {
        val start = opaqueStartLogin(password)
        val started = post(origin, "/api/auth/login/start", JSONObject().put("email", email).put("startLoginRequest", start.request)).body
        val attemptToken = started.optString("attemptToken").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val loginResponse = started.optString("loginResponse").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val finish = opaqueFinishLogin(password, start.state, loginResponse) ?: throw WrongPassword()
        // The device key's proof, only for the account it was made for: the same device comes back.
        val reply = send(origin, "/api/auth/login/finish", finishBody(attemptToken, finish.request, deviceProof(Shared.deviceIdentity(context), email, attemptToken)))
        return when (val read = signInReply(reply, StepWords.LOST_SIGN_IN)) {
            null -> Met.Session(reply, finish.exportKey)
            else -> Met.Step(PendingSignIn(origin, email, read, finish.exportKey))
        }
    }

    /*
     * A sign-in by a phone that holds the account's newest recovery phrase in memory (after its own rotation
     * or reset): a second step that names that phrase's recovery key is answered with it, so nobody is sent to
     * a step they would need those words for. A step that names another key is left for the person, and so is
     * one whose answer did not come back as a session.
     */
    fun signInHolding(context: Context, origin: String, email: String, password: String, phrase: String, recoveryVersion: Long): SignIn =
        holding(startSignIn(context, origin, email, password), phrase, recoveryVersion) { pending, proof -> answerStep(context, pending, proof) }

    internal fun holding(taken: SignIn, phrase: String, recoveryVersion: Long, answer: (PendingSignIn, com.hushos.core.StepProof) -> SessionUser): SignIn {
        val pending = (taken as? SignIn.Step)?.pending ?: return taken
        val signing = pending.challenge.phrase ?: return taken
        if (signing.recoveryVersion.toLong() != recoveryVersion || com.hushos.core.StepMethod.PHRASE !in pending.challenge.methods) return taken
        return runCatching {
            SignIn.SignedIn(answer(pending, com.hushos.core.StepProof.Phrase(com.hushos.core.twoStepPhraseSign(phrase, signing.wrappingSalt, signing.userId, pending.challenge.token))))
        }.getOrDefault(taken)
    }

    /* What `login/finish` is sent. `twoStep: 1` is what lets an account with the step sign in here: without it the server answers `update-required`. */
    internal fun finishBody(attemptToken: String, finishRequest: String, device: JSONObject?): JSONObject =
        JSONObject().put("attemptToken", attemptToken).put("finishLoginRequest", finishRequest).put("twoStep", 1).apply { device?.let { put("device", it) } }

    /*
     * What `login/finish` or `login/two-step` answered, as the core reads it: null for the session,
     * the step to answer, or a throw. A wrong password and the limiter's 429 are a sign-in's own
     * refusals, in the server's words as before; a step's refusal is a `StepRefused` with its code; a
     * reply that is not the server's answer is a `LostReply`, never a sign-in; so is the session's
     * body without its cookie.
     */
    internal fun signInReply(reply: RawReply, lost: String, answering: Boolean = false): com.hushos.core.StepChallenge? =
        when (val read = com.hushos.core.signInReplyRead(reply.status.toUShort(), reply.text)) {
            // The session is its body and its cookie: a whole body that lost the cookie on the way hands over nothing.
            is com.hushos.core.StepReply.Done -> if (reply.cookie == null) throw LostReply(lost) else null
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
    private val turnLock = java.util.concurrent.locks.ReentrantLock()
    private val turnMoved = turnLock.newCondition()
    /* Who asked, in order: the first holds the turn. */
    private val turns = ArrayDeque<Any>()
    private val holdsTurn = ThreadLocal<Boolean>()
    private val turnCancelled = ThreadLocal<(() -> Boolean)?>()

    /*
     * Runs `block` with `cancelled` asked while a password turn inside it waits. These calls block a
     * thread, so cancelling the coroutine that made one does not stop it: a caller whose screen or view
     * model has gone would otherwise make its change once the turn came round, with nobody to see what
     * it did. Asked here, it gives its place up and throws `CancellationException` instead.
     */
    fun <T> cancellable(cancelled: () -> Boolean, block: () -> T): T {
        val before = turnCancelled.get()
        turnCancelled.set(cancelled)
        try { return block() } finally { turnCancelled.set(before) }
    }

    internal fun <T> passwordTurn(block: () -> T): T {
        // Already this thread's turn (one change inside another): no second place in the line, which it would wait behind for ever.
        if (holdsTurn.get() == true) return block()
        val ticket = Any()
        val cancelled = turnCancelled.get()
        fun leave() { turnLock.lock(); try { turns.remove(ticket); turnMoved.signalAll() } finally { turnLock.unlock() } }
        turnLock.lock()
        try {
            turns.addLast(ticket)
            // Asked again at the head: cancelled while waiting, the change is not made late.
            while (turns.first() !== ticket || cancelled?.invoke() == true) {
                if (cancelled?.invoke() == true) {
                    turns.remove(ticket)
                    turnMoved.signalAll()
                    throw java.util.concurrent.CancellationException("Left before its turn came.")
                }
                turnMoved.await(50, java.util.concurrent.TimeUnit.MILLISECONDS)
            }
        } finally {
            turnLock.unlock()
        }
        holdsTurn.set(true)
        try { return block() } finally { holdsTurn.set(false); leave() }
    }

    /*
     * Removing devices proves the password again (OPAQUE in the core, bound to this session), so a
     * session alone cannot sign the other devices out and have them clear what they kept.
     */
    private fun passwordProof(session: Shared.Session, password: String): JSONObject {
        val login = opaqueStartLogin(password)
        val started = callAt(session, "/api/auth/devices/reauth", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse"))
            ?: throw AuthFailure("That password isn’t right. Check it and try again.")
        return JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request)
    }

    /* Signs another device out at once; the server refuses this phone (sign out instead). */
    fun removeDevice(context: Context, id: String, password: String) {
        val session = sessionOf(context)
        passwordTurn { callAt(session, "/api/auth/devices/$id", passwordProof(session, password), "DELETE") }
    }

    fun removeOtherDevices(context: Context, password: String): Int = removeOtherDevicesAt(sessionOf(context), password)

    /* Under the session named, in its turn: the whole exchange, so nothing of it goes out while another password change is under way. */
    internal fun removeOtherDevicesAt(session: Shared.Session, password: String): Int =
        passwordTurn { callAt(session, "/api/auth/devices/others", passwordProof(session, password), "DELETE").optInt("removed") }

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

    private fun sessionOf(context: Context): Shared.Session = Shared.session(context) ?: throw AuthFailure("Sign in first.")

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
     * The new recovery phrase, with the recovery key as the server now holds it: what the kit file
     * carries. `user`: who the sign-in after the rotation signed in, or null when no session came of it
     * (the words are then shown from memory, and the sign-in follows them). `certain` is false when the
     * rotation's reply was lost and no later reply showed a version either way: the words are shown,
     * and kept beside the old ones.
     */
    class RotatedKeys(val phrase: String, val recovery: JSONObject, val recoveryVersion: Long, val certain: Boolean, val user: SessionUser?)

    /*
     * Rotates the master key, as the web's "Rotate keys" does: a fresh account
     * key replaces the old one under the same password, the identity (and every
     * earlier one), the settings key and every workspace grant are sealed again
     * under it, and a new recovery phrase is
     * minted. The server ends every session, so this signs in again, with `email`.
     *
     * Once the last request has gone out the new phrase is returned whatever happens next: the old one
     * may be dead already, and for someone whose only second step is the phrase, losing the new one is
     * losing the account. Whether the rotation was made is read from versions, as a reset's is
     * (`proveReset`): the sign-in after it shows the new credential version or names the new recovery
     * key only if it was. That sign-in's step is answered with the new phrase, which nobody has seen
     * yet, so no one is sent to a step they would need those words for. The old versions mean it was not
     * made (`StepWords.NOT_ROTATED`); no version at all means the words are shown with a caveat.
     */
    fun rotateKeysKit(context: Context, email: String, password: String, twoStep: StepAnswer? = null): RotatedKeys = passwordTurn {
        val session = sessionOf(context)
        val made = rotateKeysAt(session, password, twoStep)
        val proved = Reset.prove { proveReset(context, session.origin, email, password, made) }
        when (val settled = Reset.settle(made.sent, proved, StepWords.NOT_ROTATED)) {
            is Reset.Settled.Refused -> throw AuthFailure(settled.said)
            is Reset.Settled.Show -> {
                // What this phone remembers follows the server: written only once the rotation is known to have been
                // made. (Signed in, the sign-in has written it already, from the envelope it was handed.)
                if (settled.certain && settled.user == null) made.memory?.let { Shared.writeDevice(context, it) }
                RotatedKeys(made.phrase, made.recovery, made.recoveryVersion.toLong(), settled.certain, settled.user)
            }
        }
    }

    /* The rotation itself, up to and including `security/finish`, under the session named and in its turn. A refusal is thrown: nothing changed. */
    internal fun rotateKeysAt(session: Shared.Session, password: String, twoStep: StepAnswer?): ResetMade = passwordTurn { rotateKeysNow(session, password, twoStep) }

    /* A change's request that got no answer of the server's own: it may have been made. */
    internal fun unanswered(error: Throwable): Boolean = error is LostReply || error is AuthUnreachable

    private fun rotateKeysNow(session: Shared.Session, password: String, twoStep: StepAnswer?): ResetMade {
        val login = opaqueStartLogin(password)
        val registration = opaqueStartRegistration(password)
        val challenge = callAt(session, "/api/auth/security/start", JSONObject().put("action", "master-key")
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
        // From here the new phrase may be the account's only one: a reply that never arrives must not cost it. It is
        // kept, and the caller reads from a later reply's versions whether the rotation was made.
        val sent = try {
            callAt(session, "/api/auth/security/finish", JSONObject().put("action", "master-key").put("attemptToken", challenge.getString("attemptToken"))
                .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
                .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                    .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                    .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
                .put("recovery", json(recovery.envelope)).put("identity", json(identity)).put("workspaces", workspaces)
                .put("identityHistory", history).apply { settingsKey?.let { put("settingsKey", json(it)) } }
                .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_SAVED).let { done(it, StepWords.LOST_SAVED) }
            Reset.Sent.Accepted
        } catch (error: AuthFailure) {
            // A refusal in the server's words (a wrong step, a limit) changed nothing, and is the form's to show.
            if (!unanswered(error)) throw error
            Reset.Sent.Unknown
        }
        return ResetMade(userId, recovery.phrase, json(recovery.envelope), sent, sealed.credentialVersion, recovery.envelope.recoveryVersion,
            memory = deviceRemember(userId, newRoot, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString()))
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
    fun changePassword(context: Context, current: String, new: String, twoStep: StepAnswer? = null) =
        Shared.writeDevice(context, changePasswordAt(sessionOf(context), current, new, twoStep))

    /* Under the session named, in its turn; returns what this phone remembers from now on. */
    internal fun changePasswordAt(session: Shared.Session, current: String, new: String, twoStep: StepAnswer?): com.hushos.core.DeviceMemory =
        passwordTurn { changePasswordNow(session, current, new, twoStep) }

    private fun changePasswordNow(session: Shared.Session, current: String, new: String, twoStep: StepAnswer?): com.hushos.core.DeviceMemory {
        val login = opaqueStartLogin(current)
        val registration = opaqueStartRegistration(new)
        val challenge = callAt(session, "/api/auth/security/start", JSONObject().put("action", "password")
            .put("startLoginRequest", login.request).put("registrationRequest", registration.request))
        val finish = opaqueFinishLogin(current, login.state, challenge.getString("loginResponse")) ?: throw AuthFailure("The current password is not right.")
        val userId = challenge.getString("userId")
        val old = envelope(challenge.getJSONObject("envelope"))
        val accountKey = accountUnlock(userId, finish.exportKey, old)
        val registered = opaqueFinishRegistration(new, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, accountKey, old.keyVersion, old.credentialVersion + 1uL)
        callAt(session, "/api/auth/security/finish", JSONObject().put("action", "password").put("attemptToken", challenge.getString("attemptToken"))
            .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
            .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_SAVED).let { done(it, StepWords.LOST_SAVED) }
        return deviceRemember(userId, accountKey, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString())
    }

    /* Proves the password once more, then the server removes the account; every local trace goes with it. */
    fun deleteAccount(context: Context, password: String, twoStep: StepAnswer? = null) {
        deleteAccountAt(sessionOf(context), password, twoStep)
        Shared.clearSession(context)
        Shared.clearDevice(context)
        AccountStore.of(context).wipe()
    }

    /* Under the session named, in its turn: the server's part of deleting the account. */
    internal fun deleteAccountAt(session: Shared.Session, password: String, twoStep: StepAnswer?) = passwordTurn {
        val login = opaqueStartLogin(password)
        val started = callAt(session, "/api/auth/delete/start", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse")) ?: throw AuthFailure("The password is not right.")
        callAt(session, "/api/auth/delete/finish", JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request)
            .apply { twoStep?.let { put("twoStep", it.json()) } }, whole = true, lost = StepWords.LOST_DELETED).let { done(it, StepWords.LOST_DELETED) }
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
