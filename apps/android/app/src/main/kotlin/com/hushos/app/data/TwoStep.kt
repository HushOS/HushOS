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
class PendingSignIn(val origin: String, val email: String, val challenge: StepChallenge, internal val exportKey: ByteArray) {
    /*
     * When this is dropped, with what the password opened: a minute after the step's own end, as the web
     * does. Nothing can answer it by then, and the key must not sit in memory for as long as the app does.
     * An end that can't be read still ends: the server's five minutes from `now`.
     */
    fun dropAt(now: java.time.Instant = java.time.Instant.now()): java.time.Instant =
        (runCatching { java.time.Instant.parse(challenge.expiresAt) }.getOrNull() ?: now.plusSeconds(300)).plusSeconds(60)
}

/*
 * Recovery words a phone showed and checked with no session to tell the server so (a rotation's, or
 * a reset's whose sign-in didn't happen): whose they are, on which server, and which phrase. The
 * check is recorded at the next sign-in only when all three are that sign-in's: another account
 * signing in on the phone, or the same one on another server, confirms nothing.
 */
data class CheckedWords(val userId: String, val origin: String, val recoveryVersion: Long) {
    /* The version to confirm for a sign-in as `userId` on `origin`, or null when the words were someone else's. */
    fun confirms(userId: String, origin: String): Long? =
        recoveryVersion.takeIf { this.userId.equals(userId, ignoreCase = true) && this.origin == origin && it > 0 }
}

/*
 * This phone's own change that ends its session (a rotation, a new password, a phrase reset), from
 * the request to the sign-in that follows. The session's end is its own doing all the way through,
 * so "You've been signed out" says nothing meanwhile: the mute is raised before the request goes out
 * (a 401 can arrive from another request before the change's own answer does), dropped if the change
 * fails, and held while the new words are on screen and while the sign-in after them is out. A
 * sign-in by any road ends it. Immutable: every move is a new value.
 */
data class OwnChange(val underWay: Boolean = false, val wordsHeld: Boolean = false, val signingIn: Boolean = false, val checked: CheckedWords? = null) {
    /* Whether an ended session says nothing for now. */
    val mutesSessionEnd: Boolean get() = underWay || wordsHeld || signingIn

    /* The change's request is about to go. */
    fun begin() = copy(underWay = true)
    /* It failed: nothing is held. */
    fun ended() = copy(underWay = false)
    /* It went through and the new words are on screen, with the sign-in still to come. */
    fun hold() = copy(underWay = false, wordsHeld = true)
    /* It went through with no words to show (a new password): the sign-in that follows is out. */
    fun signInNext() = copy(underWay = false, signingIn = true)
    /* The words were saved and checked: the sign-in that waited goes out. */
    fun wordsChecked(words: CheckedWords?) = copy(wordsHeld = false, signingIn = true, checked = words)
    /* That sign-in answered, whatever it said. */
    fun settled() = copy(signingIn = false)
    /* Signed in, by this road or another: nothing is held, and the check is recorded if the words were this sign-in's. */
    fun signedIn(userId: String, origin: String): Pair<OwnChange, Long?> = OwnChange() to checked?.confirms(userId, origin)
}

/*
 * A phrase reset once `recover/finish` has been sent, and a rotation once its `security/finish` has
 * (the same rule, with the rotation's words). The old phrase is dead the moment the server
 * takes it, and the new one exists only in this phone's memory: nothing after that point may cost it.
 * So the words are shown whatever the sign-in that follows does, and when the reset's own reply was
 * lost that sign-in (with the new password) is what says whether it was made: by the versions its
 * reply shows, never by the mere fact that it signed in.
 */
object Reset {
    /* What `recover/finish` answered: the reset, a refusal in the server's words, or nothing of the server's own. */
    sealed class Sent {
        data object Accepted : Sent()
        data class Refused(val said: String) : Sent()
        data object Unknown : Sent()
    }

    /*
     * What signing in with the new password showed, by the versions in its reply (Auth.proved). That it
     * signed in shows nothing: a reset to the password the account already had signs in either way.
     */
    sealed class Proved(internal val rank: Int) {
        /* The session's envelope is the reset's, or the step named the reset's recovery key and the new phrase passed it. */
        data class SignedIn(val user: SessionUser) : Proved(3)
        /* A reply showed the reset's version, but no session came of it. */
        data object Applied : Proved(2)
        /* A reply showed the old version, or the new password was refused: the reset was not made. */
        data object NotApplied : Proved(1)
        /* No reply showed a version. */
        data object Unknown : Proved(0)
    }

    sealed class Settled {
        /* Show the new words, signed in or not; `certain` false when nothing says the reset was made. */
        data class Show(val user: SessionUser?, val certain: Boolean) : Settled()
        /* Nothing changed: the server's words, or that the account is still as it was. */
        data class Refused(val said: String) : Settled()
    }

    /*
     * The reset is the server's `{ user }` on a 2xx. A 4xx in its own words is a refusal, and nothing
     * changed. Anything else (a 5xx, a page from something in the way, a 2xx without the account)
     * says nothing either way.
     */
    fun sent(status: Int, body: JSONObject): Sent = when {
        status in 200..299 -> if (body.optJSONObject("user") != null) Sent.Accepted else Sent.Unknown
        status in 400..499 -> (body.opt("message") as? String)?.takeIf { it.isNotEmpty() }?.let(Sent::Refused) ?: Sent.Unknown
        else -> Sent.Unknown
    }

    /* `notMade`: what is said when the account still shows its old versions (a reset's words, or a rotation's). */
    fun settle(sent: Sent, proved: Proved, notMade: String = StepWords.NOT_RESET): Settled = when {
        sent is Sent.Refused -> Settled.Refused(sent.said)
        proved is Proved.SignedIn -> Settled.Show(proved.user, certain = true)
        sent is Sent.Accepted || proved is Proved.Applied -> Settled.Show(null, certain = true)
        proved is Proved.NotApplied -> Settled.Refused(notMade)
        else -> Settled.Show(null, certain = false)
    }

    /*
     * Signs in after the reset, once more if the first try gave no session: a sign-in that failed
     * for a moment's reason is tried again while the words are still held. The better answer of the
     * two stands. An account that showed it was not reset is not asked again.
     */
    fun prove(attempt: () -> Proved): Proved {
        val first = attempt()
        if (first is Proved.SignedIn || first is Proved.NotApplied) return first
        val second = attempt()
        return if (second.rank >= first.rank) second else first
    }
}

/*
 * Account › Two-step sign-in's changes, held by the view model and not by a screen: each one's
 * result is shown once (the key, the backup codes) or says what the account now is, and a screen
 * that is rebuilt while the request is out (a rotation, a fold) must find it. In memory only.
 */
data class TwoStepFlow(
    val pending: Boolean = false,
    val error: String? = null,
    /* The pending authenticator app: its key, until it is confirmed or runs out. */
    val enrolment: TotpEnrolment? = null,
    /* Backup codes, shown once. */
    val codes: List<String>? = null,
    /* The removal of other devices, behind the codes: under way, or failed. */
    val removing: Boolean = false,
    val notRemoved: Boolean = false,
    /* The change is made and has nothing more to show: what to say as the page closes. */
    val finished: String? = null,
    /* Counts each time the settings must be read again (a lost reply: nothing says what the account now is). */
    val reread: Int = 0,
) {
    fun started() = copy(pending = true, error = null)

    /* The pending app: its key is on screen from here. */
    fun enrolled(app: TotpEnrolment) = copy(pending = false, enrolment = app)

    /*
     * What confirming the app did. The codes are kept before anything else is done. A reply that is
     * neither of the server's answers, or "replaced" for a step that was being turned on (which always
     * comes back with the codes), claims nothing: said so, and the settings are read again.
     */
    fun confirmed(result: Result<TwoStep.Confirmed>, replacing: Boolean): TwoStepFlow = result.fold(
        { confirmed ->
            when (confirmed) {
                is TwoStep.Confirmed.TurnedOn -> copy(pending = false, codes = confirmed.backupCodes)
                TwoStep.Confirmed.Replaced ->
                    if (replacing) copy(pending = false, finished = "Authenticator app replaced.")
                    else copy(pending = false, error = StepWords.LOST_TURNED_ON, reread = reread + 1)
            }
        },
        { failure ->
            when (failure) {
                // The session ended: sign-in is on screen, and says so.
                is NotAuthenticated -> copy(pending = false)
                is LostReply -> copy(pending = false, error = failure.message, reread = reread + 1)
                // The setup ran out (ten minutes): back to the start, with why.
                is SetupTimedOut -> copy(pending = false, enrolment = null, error = Problems.say(failure, Problems.SERVER))
                else -> copy(pending = false, error = Problems.say(failure, Problems.SERVER))
            }
        },
    )

    /* New codes, or why not. A lost reply may have replaced the old set: the count is read again. */
    fun newCodes(fresh: List<String>) = copy(pending = false, codes = fresh)

    /* A method removed (`on`: whether the step is still on). */
    fun removed(on: Boolean) = copy(pending = false, finished = if (on) "Authenticator app removed." else "Two-step sign-in is off.")

    /* A change that failed (`said`: the form's words, null when the step's own fields say it). After a lost reply nothing says whether it was made, so the settings are read again. */
    fun failed(failure: Throwable, said: String?) = copy(pending = false, error = said, reread = if (failure is LostReply) reread + 1 else reread)

    companion object {
        /*
         * Whether confirming the app also removes the other devices: only when the step is being turned on
         * with the box ticked. Replacing the app shows no box, and a value left from an earlier visit must
         * not sign anyone's devices out.
         */
        fun removesOthers(confirmed: TwoStep.Confirmed, signOutOthers: Boolean, replacing: Boolean): Boolean =
            confirmed is TwoStep.Confirmed.TurnedOn && signOutOthers && !replacing
    }
}

/* A step's token and the answer to it, as `login/two-step` and a change's `twoStep` field take them. */
data class StepAnswer(val token: String, val proof: StepProof) {
    /* The method this answers with: what a refusal about "this method" is about. */
    val method: StepMethod get() = when (proof) {
        is StepProof.Totp -> StepMethod.TOTP
        is StepProof.Backup -> StepMethod.BACKUP
        is StepProof.Phrase -> StepMethod.PHRASE
    }

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
    /* Turning the step on always comes back with the codes: an answer without them is not the server's answer to that. */
    val LOST_TURNED_ON = lost("two-step sign-in was turned on")
    val LOST_TURNED_OFF = lost("two-step sign-in was turned off")
    val LOST_NEW_CODES = lost("new backup codes were made")
    /* A sign-in with no step screen. */
    const val OPEN_APP = "This account asks for a second step. Open HushOS and sign in there."
    /* A step none of whose methods this build knows. */
    const val CANNOT_ANSWER = "This version of HushOS can’t answer this account’s second step. Update HushOS, then try again."
    /* The ways ran out after refusals (a paused app, a spent budget): updating would not help. */
    const val NO_WAY_LEFT = "There is no other way to answer this step from here right now. Start again in a while."
    /* A rotation whose reply was lost, and the account still shows its old versions: nothing changed. */
    const val NOT_ROTATED = "Your account key wasn’t rotated. Try again."
    /* A rotation whose reply was lost, and no reply showed a version either way: the words are shown, and the old ones kept. */
    const val ROTATION_UNCERTAIN = "HushOS couldn’t confirm that your account key was rotated. Keep your old phrase as well as these 24 words until you have signed in."
    /* A phrase reset whose reply was lost, and the account still shows its old versions: nothing changed, and the new words are not handed over. */
    const val NOT_RESET = "Your password wasn’t changed. Try again."
    /* A phrase reset whose reply was lost, and nothing could say whether it happened. */
    const val RESET_UNCERTAIN = "HushOS couldn’t confirm that your password was changed. Keep your old phrase as well as these 24 words until you have signed in. If your new password doesn’t sign you in, your old one still does."
    /* After a reset whose sign-in didn't happen. */
    const val SIGN_IN_AFTER_RESET = "Your password was changed. Sign in with your new password."
    /* The removal of other devices, asked for while turning the step on, did not happen. */
    const val OTHERS_NOT_REMOVED = "Your other devices weren’t removed. You can remove them under Devices."
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
        /*
         * What is still offered after a refusal that takes something away (shared with `StepUp`):
         * - a paused app: everything but the app;
         * - a spent budget: the budget is one for the app's codes and the backup codes, so both go together;
         * - a method the server cannot check: only that one, the one that was `tried`. The app's secret and
         *   the backup codes can sit under different server keys, so one failing says nothing of the other.
         */
        fun left(methods: List<StepMethod>, refusal: StepRefusal, tried: StepMethod?): List<StepMethod> = when (refusal) {
            StepRefusal.FROZEN -> methods.filter { it != StepMethod.TOTP }
            StepRefusal.LIMITED -> methods.filter { it != StepMethod.TOTP && it != StepMethod.BACKUP }
            StepRefusal.UNAVAILABLE -> methods.filter { it != tried }
            else -> methods
        }

        /* Null for a cancellation: nothing failed, and nothing is said. `tried` is the method the refused answer used. */
        fun after(error: Throwable, methods: List<StepMethod>, tried: StepMethod? = null): StepOutcome? = when (error) {
            is kotlinx.coroutines.CancellationException -> null
            is LostReply -> Retry(error.message ?: StepWords.LOST_STEP)
            is StepRefused -> {
                val message = error.message.orEmpty()
                when (error.refusal) {
                    StepRefusal.WRONG -> Again(message, true, methods)
                    // Nothing changed; what the refusal was about is withdrawn, and the rest stays offered.
                    StepRefusal.FROZEN, StepRefusal.LIMITED, StepRefusal.UNAVAILABLE -> Again(message, false, left(methods, error.refusal, tried))
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
        // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
        val method = shown ?: return Proof.Unready(copy(error = if (challenge.methods.isEmpty()) StepWords.CANNOT_ANSWER else StepWords.NO_WAY_LEFT))
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
            // The method on screen is the one the refused change carried.
            StepRefusal.FROZEN, StepRefusal.LIMITED, StepRefusal.UNAVAILABLE ->
                Next.AGAIN to copy(error = message, tried = false, methods = StepOutcome.left(methods, failure.refusal, shown))
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

    companion object {
        /*
         * The line under "Remove my other devices". The count is only for the words: unknown (the list
         * didn't load) or zero, the line says what ticking does without one, and the box is there all the same.
         */
        fun othersLine(others: Int?): String =
            if (others == null || others <= 0) "Any other device signed in to your account will need to sign in again, and will be asked for the second step."
            else "${if (others == 1) "One other device is" else "$others other devices are"} signed in without the second step. They’ll need to sign in again, and will be asked for it."
    }
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
            "totp-frozen" -> "Authenticator app paused after many wrong answers"
            "backup-code-used" -> "Backup code used"
            "phrase-used" -> "Recovery phrase used for the second step"
            "two-step-on" -> "Two-step sign-in turned on"
            "two-step-off" -> "Two-step sign-in turned off"
            // Said by the kind of method, so the line is right for a security key too.
            "method-added" -> when (method) { "webauthn" -> "Security key added"; "totp" -> "Authenticator app replaced"; else -> "Second-step method added" }
            "method-removed" -> when (method) { "webauthn" -> "Security key removed"; "totp" -> "Authenticator app removed"; else -> "Second-step method removed" }
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
     * A step for a change this session makes. Null when there is none to ask for here: the account
     * has no step (409), or this server has two-step switched off and so hands out no challenge
     * (501). On the second an account that turned the step on earlier is still asked for it: the
     * change goes without an answer, the server refuses it with `two-step`, and the form says so.
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
    fun startAuthenticator(at: Shared.Session, password: String, twoStep: StepAnswer? = null): TotpEnrolment = Auth.passwordTurn {
        enrolment(Auth.callAt(at, "/api/auth/two-step/totp", change(at, password, twoStep), whole = true, lost = StepWords.LOST_SETUP)) ?: throw LostReply(StepWords.LOST_SETUP)
    }

    /*
     * The readers below take a 200's body and give the server's own answer, or null: the web's
     * `readEnrolment`, `readRemoved` and `readBackupCodes` (packages/auth/src/login-reply.ts). A body
     * that is merely an object (a proxy's `{ "error": … }`) is none of them, and its change is not
     * reported as made.
     */
    private fun JSONObject.textAt(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotEmpty() }
    private fun texts(list: org.json.JSONArray?): List<String>? {
        val items = list?.let { all -> (0 until all.length()).map { all.opt(it) } }.orEmpty()
        return if (items.isNotEmpty() && items.all { it is String && it.isNotEmpty() }) items.map { it as String } else null
    }

    /* A pending app: its id, its key and its address, each there. */
    internal fun enrolment(body: JSONObject): TotpEnrolment? =
        TotpEnrolment(body.textAt("id") ?: return null, body.textAt("secret") ?: return null, body.textAt("uri") ?: return null)

    /* A removed method: `removed` true, and whether the step is still on. */
    internal fun removed(body: JSONObject): Boolean? = if (body.opt("removed") == true) body.opt("on") as? Boolean else null

    /* A new set of codes: a list that is not empty, of text that is not empty. */
    internal fun codes(body: JSONObject): List<String>? = texts(body.optJSONArray("codes"))

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
        if (body.has("backupCodes")) return texts(body.optJSONArray("backupCodes"))?.let(Confirmed::TurnedOn)
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
    fun removeMethod(at: Shared.Session, id: String, password: String, twoStep: StepAnswer?): Boolean = Auth.passwordTurn {
        removed(Auth.callAt(at, "/api/auth/two-step/methods/$id", change(at, password, twoStep), "DELETE", whole = true, lost = StepWords.LOST_TURNED_OFF))
            ?: throw LostReply(StepWords.LOST_TURNED_OFF)
    }

    /* A new set of ten backup codes, which replaces the old one, shown once. */
    fun newBackupCodes(at: Shared.Session, password: String, twoStep: StepAnswer?): List<String> = Auth.passwordTurn {
        codes(Auth.callAt(at, "/api/auth/two-step/backup-codes", change(at, password, twoStep), whole = true, lost = StepWords.LOST_NEW_CODES))
            ?: throw LostReply(StepWords.LOST_NEW_CODES)
    }

    /* The codes as a note to keep: what the web's download writes. */
    fun codesNote(codes: List<String>, email: String, made: java.time.LocalDate = java.time.LocalDate.now()): String {
        val day = made.format(java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", java.util.Locale.UK))
        return (listOf("HushOS backup codes", "Account: $email", "Made: $day", "", "Each code works once, in place of a code from your authenticator app.", "") + codes + "").joinToString("\n")
    }
}
