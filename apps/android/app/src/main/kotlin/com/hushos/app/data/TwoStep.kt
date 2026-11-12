package com.hushos.app.data

import com.hushos.core.CoreException
import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.StepReply
import com.hushos.core.backupCodeNormalize
import com.hushos.core.opaqueFinishLogin
import com.hushos.core.opaqueStartLogin
import com.hushos.core.stepAnswerJson
import com.hushos.core.stepChallengeReplyRead
import com.hushos.core.stepChangeReplyRead
import com.hushos.core.twoStepPhraseSign
import org.json.JSONObject

/*
 * Two-step sign-in on the phone (docs/two-step-design.md 4 to 7): the step a sign-in stops at, the
 * step a security change carries, and Account's settings for it. Codes are checked on the server;
 * the core reads every reply (`signInReplyRead`, `stepChangeReplyRead`) and signs the recovery
 * phrase's answer, so the phrase never leaves the phone.
 */

/* A sign-in stopped at its second step: the step, and what the password opened, kept in memory until the answer brings the envelope. */
class PendingSignIn(val origin: String, val email: String, val challenge: StepChallenge, internal val exportKey: ByteArray)

/* A step's token and the answer to it, as `login/two-step` and a change's `twoStep` field take them. */
data class StepAnswer(val token: String, val proof: StepProof) {
    /* The core writes the JSON, so both phones send the same bytes. */
    fun json(): JSONObject = JSONObject(stepAnswerJson(token, proof))
}

/* What HushOS says itself about a step; everything else on these screens is the server's own sentence. */
object StepWords {
    /* The password's reply was not the server's answer: the person tries again from the password. */
    const val LOST_SIGN_IN = "The server’s answer didn’t arrive, so HushOS can’t tell whether you were signed in. Try again."
    /* The step's reply was not the server's answer: the same answer can be sent again, or the sign-in started over. */
    const val LOST_STEP = "The server’s answer didn’t arrive, so HushOS can’t tell whether you were signed in. Try again. If you used a code, you may need to wait for the next one."
    /* A change's reply was not the server's answer: it may have gone through. The web's sentence, naming what is unknown. */
    fun lost(whether: String) = "The server’s answer didn’t arrive, so HushOS can’t tell whether $whether. Check before you try again."
    val LOST_CHANGE = lost("that went through")
    val LOST_SAVED = lost("your change was saved")
    val LOST_DELETED = lost("your account was deleted")
    val LOST_SETUP = lost("the setup was started")
    val LOST_APP_ADDED = lost("your authenticator app was added")
    val LOST_TURNED_OFF = lost("two-step sign-in was turned off")
    val LOST_NEW_CODES = lost("new backup codes were made")
    /* A sign-in with no step screen. */
    const val OPEN_APP = "This account asks for a second step. Open HushOS and sign in there."
    /* A step none of whose methods this build knows. */
    const val CANNOT_ANSWER = "This version of HushOS can’t answer this account’s second step. Update HushOS, then try again."
    /* A step that ended with nothing said. */
    const val OVER = "This sign-in timed out. Enter your password again."
}

/* The server refused a step, or a request that needed one, in its own words. */
class StepRefused(val refusal: StepRefusal, message: String, status: Int = 0) : AuthFailure(message, status)

/* A reply that was not the server's answer: nothing says whether what was asked happened. */
class LostReply(message: String) : AuthFailure(message)

/* The pending authenticator app ran out (ten minutes): the setup starts again. */
class SetupTimedOut(message: String) : AuthFailure(message, 404)

/*
 * What the step screen does after an answer did not pass. Decided here, away from any screen, so
 * every case is tested: a wrong answer asks again on the same step; a paused app, a spent budget
 * and a server that cannot check codes narrow what is offered; an ended step goes back to the
 * password with why; a lost reply offers the same answer again and never a stuck screen.
 */
sealed class StepOutcome {
    /* Still answerable: the words, whether they are the field's own (a wrong answer), and what is offered now. */
    data class Again(val message: String, val field: Boolean, val methods: List<StepMethod>) : StepOutcome()
    /* Over: back to the password, with why. */
    data class Over(val message: String) : StepOutcome()
    /* The reply was lost: say so, and offer to send the same answer again or start over. */
    data class Retry(val message: String) : StepOutcome()

    companion object {
        /* Null for a cancellation: nothing failed, and nothing is said. */
        fun after(error: Throwable, methods: List<StepMethod>): StepOutcome? = when (error) {
            is kotlinx.coroutines.CancellationException -> null
            is LostReply -> Retry(error.message ?: StepWords.LOST_STEP)
            is StepRefused -> {
                val message = error.message.orEmpty()
                when (error.refusal) {
                    StepRefusal.WRONG -> Again(message, true, methods)
                    StepRefusal.FROZEN -> Again(message, false, methods.filter { it != StepMethod.TOTP })
                    // Only codes are counted and only codes need the server's key: the phrase still passes. Nothing changed.
                    StepRefusal.LIMITED, StepRefusal.UNAVAILABLE -> Again(message, false, if (StepMethod.PHRASE in methods) listOf(StepMethod.PHRASE) else methods)
                    // The address's own limit: nothing about the step was looked at, and nothing is taken away.
                    StepRefusal.BUSY -> Again(message, false, methods)
                    StepRefusal.EXPIRED, StepRefusal.REQUIRED, StepRefusal.SETUP_REQUIRED, StepRefusal.UPDATE_REQUIRED, StepRefusal.OTHER ->
                        Over(message.ifBlank { StepWords.OVER })
                }
            }
            // A mistyped phrase, refused on this phone before anything was sent.
            is CoreException -> Again(StepDraft.phraseRefused(error), true, methods)
            // Nothing came back at all, or something failed here: the same answer can be sent again.
            else -> Again(Problems.say(error, Problems.SERVER), false, methods)
        }
    }
}

/* What a person has typed for a step: one field for each method, so switching loses nothing. */
data class StepDraft(val method: StepMethod, val totp: String = "", val backup: String = "", val phrase: String = "") {
    /* The method shown: the chosen one while it is still offered, else the first that is; null when none is. */
    fun shown(methods: List<StepMethod>): StepMethod? = if (method in methods) method else methods.firstOrNull()

    /* Why the draft cannot be sent yet, in the field's own words; null when it can. */
    fun problem(method: StepMethod): String? = when (method) {
        StepMethod.TOTP -> totp.filterNot { it.isWhitespace() }.let { digits ->
            if (digits.length == 6 && digits.all { it in '0'..'9' }) null else "Enter the 6-digit code from your authenticator app."
        }
        StepMethod.BACKUP -> if (backupCodeNormalize(backup) != null) null else "Enter one of your backup codes, 10 characters."
        StepMethod.PHRASE -> words(phrase).size.let { count -> if (count == 24) null else "Enter all 24 words of your recovery phrase. $count so far." }
    }

    /* The answer to `challenge`. The phrase is signed here (the core) and only its signature goes; a mistyped one throws the core's refusal. */
    fun answer(challenge: StepChallenge, method: StepMethod): StepAnswer = when (method) {
        StepMethod.TOTP -> StepAnswer(challenge.token, StepProof.Totp(totp))
        StepMethod.BACKUP -> StepAnswer(challenge.token, StepProof.Backup(backup))
        StepMethod.PHRASE -> {
            val signing = challenge.phrase ?: throw AuthFailure(StepWords.CANNOT_ANSWER)
            StepAnswer(challenge.token, StepProof.Phrase(twoStepPhraseSign(words(phrase).joinToString(" "), signing.wrappingSalt, signing.userId, challenge.token)))
        }
    }

    companion object {
        fun of(methods: List<StepMethod>) = StepDraft(methods.firstOrNull() ?: StepMethod.TOTP)
        fun words(text: String): List<String> = text.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

        /* The core's own sentence for a phrase it refused (it writes these for people), without the type around it. */
        fun phraseRefused(error: CoreException): String =
            error.message?.substringAfter(": ")?.takeIf { it.startsWith("Enter your 24-word") || it.startsWith("That is not a valid recovery phrase") }
                ?: "That is not a valid recovery phrase. Check each word and try again."
    }
}

/* What a change asks the step for: the server binds the token to the session and this purpose. */
enum class StepPurpose(val wire: String) { PASSWORD("password"), MASTER_KEY("master-key"), RECOVERY_KEY("recovery-key"), DELETE("delete"), TWO_STEP("two-step") }

/*
 * The second step before a change this session makes (a new password, a rotation, deleting the
 * account, a change to the step itself), as the web's `useStepUp`: whether one must be answered,
 * what was typed, and what a refusal means for the form. Immutable: every change is a new value,
 * so a screen holds one in state.
 */
data class StepUp(
    val purpose: StepPurpose,
    val challenge: StepChallenge? = null,
    val methods: List<StepMethod> = emptyList(),
    val draft: StepDraft = StepDraft.of(emptyList()),
    /* What the server said about the last answer. */
    val error: String = "",
    /* Set once the person has tried to send it: the field's own complaint shows from then. */
    val tried: Boolean = false,
) {
    /* Whether the form shows the step's fields. */
    val asked: Boolean get() = challenge != null
    val shown: StepMethod? get() = draft.shown(methods)
    /* What to show under the field: the field's own complaint once tried, else the server's words. */
    val problem: String get() = shown?.takeIf { tried }?.let(draft::problem) ?: error

    fun typed(next: StepDraft) = copy(draft = next, error = "")

    fun take(next: StepChallenge?, keep: Boolean = false): StepUp {
        val offered = next?.methods.orEmpty()
        return copy(challenge = next, methods = offered, tried = false, draft = if (keep && next != null) draft else StepDraft.of(offered))
    }

    /* What `prove` found: nothing to carry, an answer, or a field that is not ready (the step says why). */
    sealed class Proof {
        data object None : Proof()
        data class Ready(val answer: StepAnswer) : Proof()
        data class Unready(val step: StepUp) : Proof()
    }

    fun prove(): Proof {
        val challenge = challenge ?: return Proof.None
        val method = shown ?: return Proof.Unready(copy(error = StepWords.CANNOT_ANSWER))
        if (draft.problem(method) != null) return Proof.Unready(copy(tried = true))
        return try {
            Proof.Ready(draft.answer(challenge, method))
        } catch (error: CoreException) {
            // A mistyped phrase: the core's words, beside the field.
            Proof.Unready(copy(error = StepDraft.phraseRefused(error), tried = false))
        } catch (error: AuthFailure) {
            Proof.Unready(copy(error = error.message.orEmpty(), tried = false))
        }
    }

    /* What a failed change means for the step. */
    enum class Next {
        /* Not the step's: the form shows the error as its own. */
        NOT_STEP,
        /* The step's, and its fields say why: the same step can be answered again. */
        AGAIN,
        /* A new step is needed (none was asked yet, or this one is over): fetch one, keeping what was typed. */
        RENEW,
    }

    fun failed(failure: Throwable): Pair<Next, StepUp> {
        if (failure !is StepRefused) return Next.NOT_STEP to this
        val message = failure.message.orEmpty()
        return when (failure.refusal) {
            // Asked for the first time: the fields appear, and say nothing yet.
            StepRefusal.REQUIRED -> Next.RENEW to copy(error = if (challenge == null) "" else message)
            StepRefusal.EXPIRED -> Next.RENEW to copy(error = message)
            StepRefusal.WRONG -> Next.AGAIN to copy(error = message, tried = false)
            StepRefusal.FROZEN -> Next.AGAIN to copy(error = message, tried = false, methods = methods.filter { it != StepMethod.TOTP })
            StepRefusal.LIMITED, StepRefusal.UNAVAILABLE ->
                Next.AGAIN to copy(error = message, tried = false, methods = if (StepMethod.PHRASE in methods) listOf(StepMethod.PHRASE) else methods)
            StepRefusal.SETUP_REQUIRED, StepRefusal.UPDATE_REQUIRED, StepRefusal.BUSY, StepRefusal.OTHER -> Next.NOT_STEP to this
        }
    }
}

/* GET /api/auth/two-step: whether the step is on, its methods, the codes left, and whether the app is paused for new devices. */
data class TwoStepStatus(val on: Boolean, val methods: List<Method>, val backupCodesLeft: Int, val totpFrozen: Boolean) {
    /* `kind`: "totp", or "webauthn" once security keys exist. */
    data class Method(val id: String, val kind: String, val name: String?, val createdAt: String?, val lastUsedAt: String?)

    /* The authenticator app, if one is confirmed: an account has at most one. */
    val app: Method? get() = methods.firstOrNull { it.kind == "totp" }

    /* "7 of 10 left", with what to do when they run low, as the web says it. */
    val codesLeft: String get() = when {
        backupCodesLeft == 0 -> "None left. Make a new set."
        backupCodesLeft <= 2 -> "$backupCodesLeft of 10 left. Make a new set soon."
        else -> "$backupCodesLeft of 10 left"
    }

    companion object {
        /* Null when the body is not the settings' shape: nothing is shown as "off" on a guess. */
        fun from(json: JSONObject): TwoStepStatus? {
            if (json.opt("on") !is Boolean) return null
            val rows = json.optJSONArray("methods") ?: return null
            fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }
            val methods = (0 until rows.length()).mapNotNull { index ->
                val row = rows.optJSONObject(index) ?: return@mapNotNull null
                Method(row.text("id") ?: return@mapNotNull null, row.text("kind") ?: return@mapNotNull null, row.text("name"), row.text("createdAt"), row.text("lastUsedAt"))
            }
            return TwoStepStatus(json.getBoolean("on"), methods, json.optInt("backupCodesLeft"), json.optBoolean("totpFrozen"))
        }
    }
}

/* POST /api/auth/two-step/totp: the pending app's key, shown once, and its `otpauth://` address. */
data class TotpEnrolment(val id: String, val secret: String, val uri: String) {
    /* The key in groups of four, as authenticator apps show it for typing. */
    val grouped: String get() = secret.chunked(4).joinToString(" ")
    /* The address an authenticator app opens, only when it is one: nothing else the server sent is ever opened. */
    val link: String? get() = uri.takeIf { it.startsWith("otpauth://totp/") }
}

/* One line of Recent security activity (docs/two-step-design.md 7): a kind of event, of method and of device; never a name or an address. */
data class SecurityEvent(val id: String, val kind: String, val method: String?, val deviceKind: String?, val createdAt: String?) {
    /* What happened, in the web's words; a kind this build does not know is still listed. */
    val words: String get() {
        val with = when (method) {
            "totp" -> "an authenticator code"
            "backup" -> "a backup code"
            "phrase" -> "your recovery phrase"
            "webauthn" -> "a security key"
            else -> null
        }
        return when (kind) {
            "sign-in" -> with?.let { "Signed in with your password and $it" } ?: "Signed in"
            "step-failed" -> with?.let { "Wrong answer to the second step, with $it" } ?: "Wrong answer to the second step"
            "totp-frozen" -> "Authenticator app paused after many wrong codes"
            "backup-code-used" -> "Backup code used"
            "phrase-used" -> "Recovery phrase used for the second step"
            "two-step-on" -> "Two-step sign-in turned on"
            "two-step-off" -> "Two-step sign-in turned off"
            "method-added" -> "Authenticator app replaced"
            "method-removed" -> "Authenticator app removed"
            "backup-codes-made" -> "New backup codes made"
            else -> "Security change"
        }
    }

    /* "Browser", "iPhone or iPad", "Android"; null when the server names no kind. */
    val device: String? get() = when (deviceKind) {
        "web" -> "Browser"
        "ios" -> "iPhone or iPad"
        "android" -> "Android"
        else -> null
    }

    companion object {
        fun from(json: JSONObject): SecurityEvent? {
            fun text(key: String): String? = if (!json.has(key) || json.isNull(key)) null else json.optString(key).ifEmpty { null }
            return SecurityEvent(text("id") ?: return null, text("kind") ?: return null, text("method"), text("deviceKind"), text("createdAt"))
        }
    }
}

/* The routes, each under a session named by the caller (`at`), so tests run them against a server of their own. */
object TwoStep {
    private fun status(code: Int) = code.toUShort()

    /* The account's two-step settings; null on a server that has two-step off (501), where Account shows nothing of it. */
    fun status(at: Shared.Session): TwoStepStatus? {
        val reply = Auth.requestAt(at, "/api/auth/two-step")
        if (reply.status == 501) return null
        if (reply.status == 401) throw NotAuthenticated()
        val status = if (reply.status == 200) TwoStepStatus.from(reply.body) else null
        return status ?: throw AuthFailure(reply.body.optString("message").takeIf { reply.status != 200 && it.isNotBlank() } ?: "Two-step sign-in couldn’t be loaded.", reply.status)
    }

    /* The last 90 days, newest first. */
    fun securityEvents(at: Shared.Session): List<SecurityEvent> {
        val events = Auth.callAt(at, "/api/auth/security-events").optJSONArray("events") ?: return emptyList()
        return (0 until events.length()).mapNotNull { events.optJSONObject(it)?.let(SecurityEvent::from) }
    }

    /*
     * A step for a change this session makes. Null when the account has no step to ask for (the
     * server answers 409, or 501 where two-step is off and the account never had it): the change
     * goes without one.
     */
    fun challenge(at: Shared.Session, purpose: StepPurpose): StepChallenge? {
        val reply = Auth.requestAt(at, "/api/auth/two-step/challenge", JSONObject().put("purpose", purpose.wire))
        if (reply.status == 401) throw NotAuthenticated()
        if (reply.status == 409 || reply.status == 501) return null
        return when (val read = stepChallengeReplyRead(status(reply.status), reply.text)) {
            is StepReply.Step -> read.challenge
            is StepReply.Refused -> throw StepRefused(read.refusal, read.message, reply.status)
            else -> throw LostReply(StepWords.LOST_CHANGE)
        }
    }

    /* Changing the step proves the password again: an OPAQUE exchange bound to this session (`two-step/reauth`). */
    private fun change(at: Shared.Session, password: String, twoStep: StepAnswer?): JSONObject {
        val login = opaqueStartLogin(password)
        val started = Auth.callAt(at, "/api/auth/two-step/reauth", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse"))
            ?: throw AuthFailure("That password isn’t right. Check it and try again.")
        return JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request)
            .apply { twoStep?.let { put("twoStep", it.json()) } }
    }

    /* A pending authenticator app, good for ten minutes: the key to type and the address to open. `twoStep` once the step is on (replacing the app). */
    fun startAuthenticator(at: Shared.Session, password: String, twoStep: StepAnswer? = null): TotpEnrolment {
        val reply = Auth.callAt(at, "/api/auth/two-step/totp", change(at, password, twoStep), whole = true, lost = StepWords.LOST_SETUP)
        val secret = reply.optString("secret")
        if (secret.isEmpty() || reply.optString("id").isEmpty() || reply.opt("uri") !is String) throw LostReply(StepWords.LOST_SETUP)
        return TotpEnrolment(reply.getString("id"), secret, reply.getString("uri"))
    }

    /* What confirming the pending app did: it turned the step on (the ten backup codes, shown once), or it replaced the app. */
    sealed class Confirmed {
        data class TurnedOn(val backupCodes: List<String>) : Confirmed()
        data object Replaced : Confirmed()
    }

    /*
     * The server's answer to a confirmation, exactly: `{ "backupCodes": [...] }` when it turned the
     * step on, `{ "replaced": true }` when it replaced the app. Anything else is not one: an empty
     * object, an object with other keys (a proxy's `{ "error": … }` with a 200), codes that are not
     * text. Read as "replaced", such a reply would tell someone their new app is on when nothing says so.
     */
    internal fun confirmed(body: JSONObject): Confirmed? {
        if (body.length() != 1) return null
        body.optJSONArray("backupCodes")?.let { codes ->
            val texts = (0 until codes.length()).map { codes.opt(it) }
            return if (texts.isNotEmpty() && texts.all { it is String && it.isNotEmpty() }) Confirmed.TurnedOn(texts.map { it as String }) else null
        }
        // The JSON `true` itself: not 1, not "true".
        return if (body.opt("replaced") == true) Confirmed.Replaced else null
    }

    /* Confirms the pending app with a code from it. A reply that is neither of the server's two answers is lost: the app may have been added. */
    fun confirmAuthenticator(at: Shared.Session, id: String, code: String): Confirmed {
        val reply = Auth.requestAt(at, "/api/auth/two-step/totp/$id/confirm", JSONObject().put("code", code.filterNot { it.isWhitespace() }))
        return when (val read = stepChangeReplyRead(status(reply.status), reply.text)) {
            is StepReply.Done -> confirmed(reply.body) ?: throw LostReply(StepWords.LOST_APP_ADDED)
            is StepReply.Refused -> when (reply.status) {
                401 -> throw NotAuthenticated()
                404 -> throw SetupTimedOut(read.message)
                else -> throw StepRefused(read.refusal, read.message, reply.status)
            }
            else -> throw LostReply(StepWords.LOST_APP_ADDED)
        }
    }

    /* Removes a method: the password and the step. Returns whether the step is still on; removing the last turns it off and deletes the codes. */
    fun removeMethod(at: Shared.Session, id: String, password: String, twoStep: StepAnswer?): Boolean {
        val reply = Auth.callAt(at, "/api/auth/two-step/methods/$id", change(at, password, twoStep), "DELETE", whole = true, lost = StepWords.LOST_TURNED_OFF)
        // The server's own answer: `removed` true and whether the step is still on. Without both, nothing says it was removed.
        if (reply.opt("removed") != true || reply.opt("on") !is Boolean) throw LostReply(StepWords.LOST_TURNED_OFF)
        return reply.getBoolean("on")
    }

    /* A new set of ten backup codes, which replaces the old one, shown once. */
    fun newBackupCodes(at: Shared.Session, password: String, twoStep: StepAnswer?): List<String> {
        val codes = Auth.callAt(at, "/api/auth/two-step/backup-codes", change(at, password, twoStep), whole = true, lost = StepWords.LOST_NEW_CODES).optJSONArray("codes")
        val texts = codes?.let { list -> (0 until list.length()).map { list.opt(it) } }.orEmpty()
        if (texts.isEmpty() || !texts.all { it is String && it.isNotEmpty() }) throw LostReply(StepWords.LOST_NEW_CODES)
        return texts.map { it as String }
    }

    /* The codes as a note to keep: what the web's download writes. */
    fun codesNote(codes: List<String>, email: String, made: java.time.LocalDate = java.time.LocalDate.now()): String {
        val day = made.format(java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", java.util.Locale.UK))
        return (listOf("HushOS backup codes", "Account: $email", "Made: $day", "", "Each code works once, in place of a code from your authenticator app.", "") + codes + "").joinToString("\n")
    }
}
