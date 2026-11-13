package com.hushos.app.data

import com.hushos.core.CoreException
import com.hushos.core.KeyAdded
import com.hushos.core.KeyAddedReply
import com.hushos.core.KeyCreation
import com.hushos.core.KeyOptionsReply
import com.hushos.core.KeyRegistration
import com.hushos.core.StepChallenge
import com.hushos.core.StepMethod
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.StepReply
import com.hushos.core.backupCodeNormalize
import com.hushos.core.keyAddedReplyRead
import com.hushos.core.keyOptionsReplyRead
import com.hushos.core.keyRegistrationJson
import com.hushos.core.opaqueFinishLogin
import com.hushos.core.opaqueStartLogin
import com.hushos.core.stepAnswerJson
import com.hushos.core.stepChallengeReplyRead
import com.hushos.core.stepChangeReplyRead
import com.hushos.core.stepMethodsShown
import com.hushos.core.twoStepPhraseSign
import org.json.JSONObject

/*
 * Two-step sign-in on the phone (docs/two-step-design.md 4 to 7): the step a sign-in stops at, the
 * step a security change carries, and Account's settings for it. Codes are checked on the server;
 * the core reads every reply (`signInReplyRead`, `stepChangeReplyRead`) and signs the recovery
 * phrase's answer, so the phrase never leaves the phone.
 */

/* A sign-in stopped at its second step: the step, and what the password opened, kept in memory until the answer brings the envelope. */
class PendingSignIn(val origin: String, val email: String, val challenge: StepChallenge, internal val exportKey: ByteArray, internal val received: Long = uptime()) {
    /*
     * How long until this is dropped, with what the password opened (zero or less: now): the server's
     * five minutes and one more, as the web allows, counted from when the step arrived. Nothing can
     * answer it by then, and the key must not sit in memory for as long as the app does.
     *
     * Counted on the clock that runs since boot, never against the step's own `expiresAt`: that is the
     * server's wall clock, and a phone whose date is set a few minutes fast would find every step over
     * before it was shown, and could never sign in.
     */
    fun dropIn(now: Long = uptime()): Long = LIFE_MILLIS - (now - received)

    companion object {
        const val LIFE_MILLIS = 6 * 60_000L
    }
}

/* Milliseconds since boot, sleep included: unlike the wall clock nobody can set it. A test puts its own in. */
internal var uptime: () -> Long = { android.os.SystemClock.elapsedRealtime() }

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
     * What signing in with the new password showed, by what its reply carries of the change itself
     * (Auth.proved): the salt this change generated, on the session's envelope or on the recovery key
     * the second step names. That it signed in shows nothing: a reset to the password the account
     * already had signs in either way.
     */
    sealed class Proved(internal val rank: Int) {
        /* The session's envelope is this change's, or the step named this change's recovery key and the new phrase passed it. */
        data class SignedIn(val user: SessionUser) : Proved(3)
        /*
         * Signed in on the account as it was (a rotation only: the password is the same either way). Not proof
         * that nothing changed, so the words are shown with "keep both", and the person stays in the app.
         */
        data class Unconfirmed(val user: SessionUser) : Proved(3)
        /* A reply carried this change's salt, but no session came of it. */
        data object Applied : Proved(2)
        /* A reply carried another salt, or the new password was refused. Not proof that nothing changed: the commit can land a second after the look. */
        data object NotApplied : Proved(1)
        /* No reply carried a salt. */
        data object Unknown : Proved(0)
    }

    sealed class Settled {
        /* Show the new words, signed in or not; `certain` false when nothing says the change was made. */
        data class Show(val user: SessionUser?, val certain: Boolean) : Settled()
        /* The server answered a refusal, in these words: nothing changed, and the new words are not shown. */
        data class Refused(val said: String) : Settled()
    }

    /*
     * What the change's last request answered. `made` says whether a 2xx is the server's own answer
     * (a reset's `{ user }`, a change's `{ success: true }`). A 4xx with the server's own words is an
     * answered refusal: nothing changed. Anything else (a 5xx, a page from something in the way, a 2xx
     * that is not the answer, a 4xx with nothing of the server's in it) says nothing either way.
     */
    fun sent(status: Int, body: JSONObject, made: (JSONObject) -> Boolean = { it.optJSONObject("user") != null }): Sent = when {
        status in 200..299 -> if (made(body)) Sent.Accepted else Sent.Unknown
        status in 400..499 -> (body.opt("message") as? String)?.takeIf { it.isNotBlank() }?.let(Sent::Refused) ?: Sent.Unknown
        else -> Sent.Unknown
    }

    /*
     * The new words are withheld only when the server answered a refusal. Once the request has left
     * without one they are always shown: a look that found the account as it was is not proof, since
     * the commit can land a second later, and words that were dropped cannot be shown again. Then
     * they come with "keep both until you have signed in" (`certain` false).
     */
    fun settle(sent: Sent, proved: Proved): Settled = when {
        sent is Sent.Refused -> Settled.Refused(sent.said)
        proved is Proved.SignedIn -> Settled.Show(proved.user, certain = true)
        // Signed in, on the account as the look found it: the server's own answer stands if there was one.
        proved is Proved.Unconfirmed -> Settled.Show(proved.user, certain = sent is Sent.Accepted)
        sent is Sent.Accepted || proved is Proved.Applied -> Settled.Show(null, certain = true)
        else -> Settled.Show(null, certain = false)
    }

    /* An answered refusal's words: the server's why, then that nothing changed (`notMade`, the reset's sentence or the rotation's). */
    fun refusal(said: String, notMade: String): String = if (said.isBlank()) notMade else "${said.trim()} $notMade"

    /*
     * Signs in after the reset, once more if the first try gave no session: a sign-in that failed
     * for a moment's reason is tried again while the words are still held, and so is one that found
     * the account as it was (the change may land a moment later). The better answer of the two stands.
     */
    fun prove(attempt: () -> Proved): Proved {
        val first = attempt()
        if (first is Proved.SignedIn || first is Proved.Unconfirmed) return first
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
    /* The pending passkey or security key: what the phone's sheet is asked, until a key answers or the server refuses one. */
    val creation: KeyCreation? = null,
    /* Backup codes, shown once: kept until the person has said they are done with them, whatever page they were on when the codes arrived. */
    val codes: List<String>? = null,
    /* The codes replace an earlier set (New codes), rather than come with turning the step on. */
    val codesReplace: Boolean = false,
    /* The removal of other devices, behind the codes: under way, or failed. */
    val removing: Boolean = false,
    val notRemoved: Boolean = false,
    /* The change is made and has nothing more to show: what to say as the page closes. */
    val finished: String? = null,
    /* Counts each time the settings must be read again (a lost reply: nothing says what the account now is). */
    val reread: Int = 0,
) {
    fun started() = copy(pending = true, error = null)

    /*
     * A page of it was opened or left: nothing of the last one is carried over. Except a request
     * still out, whose answer has to land, and codes nobody has seen yet: the server made them
     * already, and they are shown nowhere else.
     */
    fun cleared(): TwoStepFlow = if (pending || codes != null) this else TwoStepFlow(reread = reread)

    /* The codes were shown, and the person is done with them. */
    fun seen(): TwoStepFlow = TwoStepFlow(reread = reread + 1)

    /* The pending app: its key is on screen from here. */
    fun enrolled(app: TotpEnrolment) = copy(pending = false, enrolment = app)

    /*
     * What confirming the app did. The codes are kept before anything else is done. A reply that is
     * neither of the server's answers, or "replaced" for a step that was being turned on (which always
     * comes back with the codes), claims nothing: said so, and the settings are read again. The server
     * answers "replaced" for any app that is not the account's first method, one added beside keys too.
     */
    fun confirmed(result: Result<TwoStep.Confirmed>, setup: AppSetup): TwoStepFlow = result.fold(
        { confirmed ->
            when (confirmed) {
                is TwoStep.Confirmed.TurnedOn -> copy(pending = false, codes = confirmed.backupCodes)
                TwoStep.Confirmed.Replaced -> when (setup) {
                    AppSetup.REPLACE -> copy(pending = false, finished = "Authenticator app replaced.")
                    AppSetup.ADD -> copy(pending = false, finished = "Authenticator app added.")
                    AppSetup.ON -> copy(pending = false, error = StepWords.LOST_TURNED_ON, reread = reread + 1)
                }
            }
        },
        { failure ->
            when (failure) {
                // The session ended: sign-in is on screen, and says so.
                is NotAuthenticated -> copy(pending = false)
                is LostReply -> copy(pending = false, error = failure.message, reread = reread + 1)
                // The setup ran out (ten minutes): back to the start, with why.
                is SetupTimedOut -> copy(pending = false, enrolment = null, error = Problems.say(failure, Problems.SERVER))
                // The server's own refusal (a wrong code) changed nothing.
                is StepRefused -> copy(pending = false, error = Problems.say(failure, Problems.SERVER))
                // A dropped connection or a gateway's 502 may hide a confirmation that went through: read again too.
                else -> copy(pending = false, error = Problems.say(failure, Problems.SERVER), reread = reread + 1)
            }
        },
    )

    /* New codes, or why not. A lost reply may have replaced the old set: the count is read again. */
    fun newCodes(fresh: List<String>) = copy(pending = false, codes = fresh, codesReplace = true)

    /* A method removed (`on`: whether the step is still on; `app`: it was the authenticator app, not a key). */
    fun removed(on: Boolean, app: Boolean = true) = copy(pending = false, finished = when {
        !on -> "Two-step sign-in is off."
        app -> "Authenticator app removed."
        else -> "Passkey or security key removed."
    })

    /* The pending key: the phone's sheet is asked from here, on the press that adds it. */
    fun keyStarted(key: KeyCreation) = copy(pending = false, creation = key)

    /*
     * What sending the key's answer did. `first`: the account had no method, so this key turns the step on.
     * - The codes come only with turning the step on, and are kept before anything else is done.
     * - Turning it on without codes in the reply is not the server's answer to that: said so, and read again.
     * - Anything else that came back ends the setup: a registration is good for one answer, so the person
     *   starts again from the password, with the server's words. It may also hide a key that was added (a
     *   lost reply, a dropped connection), so the settings are read again.
     */
    fun keyAdded(result: Result<KeyAdded>, first: Boolean): TwoStepFlow = result.fold(
        { added ->
            when {
                added.backupCodes.isNotEmpty() -> copy(pending = false, creation = null, codes = added.backupCodes)
                first -> copy(pending = false, creation = null, error = StepWords.LOST_TURNED_ON, reread = reread + 1)
                else -> copy(pending = false, creation = null, finished = "Passkey or security key added.")
            }
        },
        { failure ->
            when (failure) {
                // The session ended: sign-in is on screen, and says so.
                is NotAuthenticated -> copy(pending = false, creation = null)
                else -> copy(pending = false, creation = null, error = Problems.say(failure, Problems.SERVER), reread = reread + 1)
            }
        },
    )

    /*
     * A change that failed (`said`: the form's words, null when the step's own fields say it). The step's own refusal
     * changed nothing; any other failure may hide a change that went through (a lost reply, a dropped connection, a
     * gateway's 502), so the settings are read again.
     */
    fun failed(failure: Throwable, said: String?) = copy(pending = false, error = said, reread = if (failure is StepRefused) reread else reread + 1)

    companion object {
        /*
         * Whether adding a method also removes the other devices: only when it turned the step on (`turnedOn`:
         * the reply carried the codes), on a page that was turning it on (`first`), with the box ticked.
         * Replacing the app or adding beside another method shows no box, and a value left from an earlier
         * visit must not sign anyone's devices out.
         */
        fun removesOthers(turnedOn: Boolean, signOutOthers: Boolean, first: Boolean): Boolean = turnedOn && signOutOthers && first
    }
}

/*
 * What an authenticator app is being set up as: the account's first method (it turns the step on),
 * a new app in place of the one it has, or an app beside its passkeys and security keys.
 */
enum class AppSetup { ON, REPLACE, ADD }

/* A step's token and the answer to it, as `login/two-step` and a change's `twoStep` field take them. */
data class StepAnswer(val token: String, val proof: StepProof) {
    /* The method this answers with: what a refusal about "this method" is about. */
    val method: StepMethod get() = when (proof) {
        is StepProof.Totp -> StepMethod.TOTP
        is StepProof.Backup -> StepMethod.BACKUP
        is StepProof.Phrase -> StepMethod.PHRASE
        is StepProof.Webauthn -> StepMethod.WEBAUTHN
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
    val LOST_KEY_ADDED = lost("your passkey or security key was added")
    /* The phone's sheet was closed, or no key answered: nothing was sent, and the step is still there. */
    const val PASSKEY_UNUSED = "Your passkey or security key wasn’t used. Try again, or use another way."
    /* The same while adding one: the setup still stands. */
    const val PASSKEY_NOT_ADDED = "Your passkey or security key wasn’t added. Try again."
    /* On a server this app cannot use a key for: the list is still shown, named and pruned here. */
    const val KEYS_IN_BROWSER = "Passkeys and security keys are added in a browser on this server. You can rename or remove them here."
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
    /* A rotation the server refused, after its own words: nothing changed. Said only after an answered refusal. */
    const val NOT_ROTATED = "Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again."
    /* A rotation whose request left without an answered refusal, and nothing showed it was made: the words are shown, and the old ones kept. */
    const val ROTATION_UNCERTAIN = "We couldn’t confirm that your recovery phrase was replaced. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you know which one your account uses."
    /* A phrase reset the server refused, after its own words: nothing changed. Said only after an answered refusal. */
    const val NOT_RESET = "Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again."
    /* A phrase reset whose request left without an answered refusal, and nothing showed it was made. */
    const val RESET_UNCERTAIN = "We couldn’t confirm that your password was changed. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you have signed in."
    /*
     * The panel that shows new words to someone the change did not sign in again here, in the web's
     * words (apps/web/src/components/new-phrase.tsx): its title, what it says after each change, the
     * line under the words, and its way on.
     */
    const val NEW_PHRASE_TITLE = "Save your new recovery phrase"
    const val NEW_PHRASE_AFTER_RESET = "Your password is changed, and your old recovery phrase no longer works. These 24 words replace it."
    const val NEW_PHRASE_AFTER_ROTATION = "Your old recovery phrase no longer works. These 24 words replace it."
    const val NEW_PHRASE_ONCE = "They are shown here once. If your account asks for a second step when you sign in, these words answer it."
    const val NEW_PHRASE_SAVED = "I’ve saved these words"
    /* After a reset nothing confirmed: the password is not said to have changed. */
    const val SIGN_IN_AFTER_UNCERTAIN_RESET = "Sign in with your new password. If it doesn’t work, your old one still does."
    /* After a reset whose sign-in didn't happen. */
    const val SIGN_IN_AFTER_RESET = "Your password was changed. Sign in with your new password."
    /* The removal of other devices, asked for while turning the step on, did not happen. */
    const val OTHERS_NOT_REMOVED = "Your other devices weren’t removed. You can remove them under Devices."
    /* A password exchange that waited a minute for its turn behind another: nothing was sent. The web's words for its own timeout. */
    const val TOO_LONG = "This took too long. Please try again."
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
         * - a spent budget: the budget is one for the app's codes and the backup codes, so both go together, and
         *   only what it does not cover stays (a passkey or security key, and the phrase), as the web's `methodsAfter`;
         * - a method the server cannot check: only that one, the one that was `tried`. The app's secret and
         *   the backup codes can sit under different server keys, so one failing says nothing of the other.
         */
        fun left(methods: List<StepMethod>, refusal: StepRefusal, tried: StepMethod?): List<StepMethod> = when (refusal) {
            StepRefusal.FROZEN -> methods.filter { it != StepMethod.TOTP }
            StepRefusal.LIMITED -> methods.filter { it == StepMethod.WEBAUTHN || it == StepMethod.PHRASE }
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
            // The phone's sheet was closed, or no key answered: nothing was sent, and everything stays offered.
            is KeyUnused -> Again(error.message ?: StepWords.PASSKEY_UNUSED, true, methods)
            // Nothing came back at all, or something failed here: the same answer can be sent again.
            else -> Again(Problems.say(error, Problems.SERVER), false, methods)
        }
    }
}

/*
 * What a person has typed for a step: one field for each method, so switching loses nothing. A
 * passkey or security key has no field: its answer is made when the step is sent (`proved`).
 */
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
        StepMethod.WEBAUTHN -> null
    }

    /*
     * The answer to `challenge`, made as it is sent. A key is asked here and nowhere else: the phone's
     * sheet opens on the press that sends the answer, never when the step appears. One that did not
     * answer (a closed sheet, no key) is `KeyUnused`: nothing goes out, and the step stays.
     */
    suspend fun proved(challenge: StepChallenge, method: StepMethod, sheet: KeySheet): StepAnswer {
        if (method != StepMethod.WEBAUTHN) return answer(challenge, method)
        val request = challenge.keyRequest ?: throw KeyUnused()
        return StepAnswer(challenge.token, StepProof.Webauthn(sheet.assertion(request) ?: throw KeyUnused()))
    }

    /* The answer to `challenge`. The phrase is signed here (the core) and only its signature goes; a mistyped one throws the core's refusal. */
    fun answer(challenge: StepChallenge, method: StepMethod): StepAnswer = when (method) {
        // A key's answer is not typed: `proved` asks the key.
        StepMethod.WEBAUTHN -> throw KeyUnused()
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

    /*
     * What the change carries. A passkey or security key is asked here, on the press that makes the
     * change, after everything typed has been checked; one that did not answer leaves the step as it
     * was, with why beside it, and the change is not sent.
     */
    suspend fun prove(sheet: KeySheet): Proof {
        val challenge = challenge ?: return Proof.None
        // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
        val method = shown ?: return Proof.Unready(copy(error = if (challenge.methods.isEmpty()) StepWords.CANNOT_ANSWER else StepWords.NO_WAY_LEFT))
        if (draft.problem(method) != null) return Proof.Unready(copy(tried = true))
        return try {
            Proof.Ready(draft.proved(challenge, method, sheet))
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

/*
 * GET /api/auth/two-step: whether the step is on, its methods, the codes left, whether the app is
 * paused for new devices, and which kind is asked for first (`defaultKind`: "webauthn", "totp",
 * "device", or null).
 */
data class TwoStepStatus(val on: Boolean, val methods: List<Method>, val backupCodesLeft: Int, val totpFrozen: Boolean, val defaultKind: String? = null) {
    /* `kind`: "totp", or "webauthn" for a passkey or security key. `synced`: a passkey a password manager keeps. */
    data class Method(val id: String, val kind: String, val name: String?, val createdAt: String?, val lastUsedAt: String?, val synced: Boolean = false) {
        val isApp: Boolean get() = kind == TOTP

        /* A key's name in the list; one the server sent without a name is still listed. */
        val shownName: String get() = name ?: "Security key"

        /* "Saved in a password manager · Added 14 Nov · Last used 14 Nov": where it lives only for a synced key, and each date only when there is one. `day` words a date. */
        fun detail(day: (String?) -> String?): String =
            listOfNotNull("Saved in a password manager".takeIf { synced }, day(createdAt)?.let { "Added $it" }, day(lastUsedAt)?.let { "Last used $it" }).joinToString(" · ")
    }

    /* The authenticator app, if one is confirmed: an account has at most one. */
    val app: Method? get() = methods.firstOrNull { it.isApp }

    /* The account's passkeys and security keys, in the server's order. */
    val keys: List<Method> get() = methods.filter { it.kind == WEBAUTHN }

    /* The account's only method is not removed: turning it off is turning the step off. */
    fun last(method: Method): Boolean = methods.size == 1 && methods.single().id == method.id
    fun removeWords(method: Method): String = if (last(method)) "Turn off" else "Remove"

    /* Which kind is asked for first is a choice only with both kinds. */
    private val choosing: Boolean get() = on && app != null && keys.isNotEmpty()
    /* The Default badge sits on the kind `defaultKind` names, and Make default on the other; neither with one kind. */
    fun isDefault(kind: String): Boolean = choosing && defaultKind == kind
    fun canMakeDefault(kind: String): Boolean = choosing && defaultKind != kind

    /* Add is offered only where this phone can use a key for this server (`passkeys`), and below the limit. */
    fun canAddKey(passkeys: Boolean): Boolean = passkeys && keys.size < Passkeys.LIMIT

    /*
     * What the key list says beneath itself, each line only while it is true (docs/two-step-design.md 3, 12):
     * a synced passkey beside the password is one factor; a passkey stops a fake page only when it is the
     * way used; one key alone is one loss from the backup codes; the limit; and where this phone can't add one.
     */
    fun keyNotes(passkeys: Boolean): List<String> = listOfNotNull(
        "A passkey saved in the same password manager as your password is one factor, not two: whoever opens the manager has both.".takeIf { keys.any { it.synced } },
        "A passkey stops a fake sign-in page only when you use it. A fake page can ask you to use another way instead.".takeIf { keys.isNotEmpty() && app != null },
        "Add a second key and keep it somewhere else, in case this one is lost.".takeIf { keys.size == 1 },
        "You have ten, the most an account can have.".takeIf { keys.size >= Passkeys.LIMIT },
        StepWords.KEYS_IN_BROWSER.takeIf { !passkeys },
    )

    /* "7 of 10 left", with what to do when they run low, as the web says it. */
    val codesLeft: String get() = when {
        backupCodesLeft == 0 -> "None left. Make a new set."
        backupCodesLeft <= 2 -> "$backupCodesLeft of 10 left. Make a new set soon."
        else -> "$backupCodesLeft of 10 left"
    }

    companion object {
        const val TOTP = "totp"
        const val WEBAUTHN = "webauthn"

        /* A kind's name, as the settings' rows and the default's line say it. */
        fun kindWords(kind: String): String = if (kind == WEBAUTHN) "Passkey or security key" else "Authenticator app"

        /* What changing the default says once the server has. */
        fun defaultSaid(kind: String): String = "${kindWords(kind)} is now asked for first."

        /* One method as the server lists it; null without an id or a kind. */
        fun method(row: JSONObject): Method? {
            fun text(key: String): String? = if (!row.has(key) || row.isNull(key)) null else row.optString(key).ifEmpty { null }
            return Method(text("id") ?: return null, text("kind") ?: return null, text("name"), text("createdAt"), text("lastUsedAt"), row.opt("synced") == true)
        }

        /* Null when the body is not the settings' shape: nothing is shown as "off" on a guess. */
        fun from(json: JSONObject): TwoStepStatus? {
            if (json.opt("on") !is Boolean) return null
            val rows = json.optJSONArray("methods") ?: return null
            val methods = (0 until rows.length()).mapNotNull { index -> rows.optJSONObject(index)?.let(::method) }
            return TwoStepStatus(json.getBoolean("on"), methods, json.optInt("backupCodesLeft"), json.optBoolean("totpFrozen"), json.opt("defaultKind") as? String)
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
            "webauthn" -> "a passkey or security key"
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
            // Said by the kind of method. An app is "added", not "replaced": with keys, one can be added beside a method too.
            "method-added" -> when (method) { "webauthn" -> "Passkey or security key added"; "totp" -> "Authenticator app added"; else -> "Second-step method added" }
            "method-removed" -> when (method) { "webauthn" -> "Passkey or security key removed"; "totp" -> "Authenticator app removed"; else -> "Second-step method removed" }
            "backup-codes-made" -> "New backup codes made"
            // The kind the default moved to is the line's method.
            "default-changed" -> when (method) { "webauthn" -> "Default changed to passkey or security key"; "totp" -> "Default changed to authenticator app"; else -> "Default changed" }
            "key-counter" -> "A security key was refused: it may have been copied"
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

    /*
     * The account's two-step settings; null on a server that has two-step off (501), where Account shows nothing of it.
     * `?methods=` names the kinds this build can list beyond the app, on every server (an older one ignores it), and
     * whether or not this phone can use them here: a key added in a browser is still shown, named and removed.
     */
    fun status(at: Shared.Session): TwoStepStatus? {
        val reply = Auth.requestAt(at, "/api/auth/two-step?methods=" + stepMethodsShown().joinToString(","))
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
     * A step for a change this session makes. Null when the account has no step (409): the change
     * goes without one. The route does not look at TWO_STEP_ENABLED (only setting the step up and
     * managing it answer 501 while that is off): an account that has the step is asked for it on
     * every server.
     */
    /*
     * `adverts` and `passkeys`: the step names what this phone can answer beyond codes and the phrase
     * (`twoStepMethods`) to a server that reads the field, by the rule in `StepNames.atChange`, and a
     * passkey or security key is offered only where this phone can use one (`offered`).
     */
    fun challenge(at: Shared.Session, purpose: StepPurpose, adverts: StepAdverts, passkeys: Boolean = Passkeys.usable(at.origin)): StepChallenge? {
        val reply = StepNames.atChange<Auth.SessionReply>(adverts, at.origin, { it.status }) { named ->
            Auth.requestAt(at, "/api/auth/two-step/challenge", challengeBody(purpose, if (named) com.hushos.core.stepMethodsNamed(passkeys) else null))
        }
        if (reply.status == 401) throw NotAuthenticated()
        if (reply.status == 409) return null
        return when (val read = stepChallengeReplyRead(status(reply.status), reply.text)) {
            is StepReply.Step -> read.challenge.offered(passkeys)
            is StepReply.Refused -> throw StepRefused(read.refusal, read.message, reply.status)
            else -> throw LostReply(StepWords.LOST_CHANGE)
        }
    }

    /* What `two-step/challenge` is sent; `methods` null for a server that does not read the field. */
    internal fun challengeBody(purpose: StepPurpose, methods: List<String>?): JSONObject =
        JSONObject().put("purpose", purpose.wire).apply { methods?.let { put("twoStepMethods", org.json.JSONArray(it)) } }

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

    /*
     * Starts adding a passkey or security key: the password again and, once the step is on, the step.
     * Answers what the phone's sheet is then asked, with the registration token its answer goes back
     * with. The core reads the reply whole: options short of what the server always sets are lost.
     */
    fun keyOptions(at: Shared.Session, password: String, twoStep: StepAnswer? = null): KeyCreation = Auth.passwordTurn {
        keyCreation(Auth.requestAt(at, "/api/auth/two-step/keys/options", change(at, password, twoStep)))
    }

    /* What `two-step/keys/options` answered: the options whole, the step's or the route's own refusal thrown as every change's is, or a lost reply. */
    internal fun keyCreation(reply: Auth.SessionReply): KeyCreation {
        if (reply.status !in 200..299) Auth.refused(reply, whole = true, lost = StepWords.LOST_SETUP)
        return (keyOptionsReplyRead(status(reply.status), reply.text) as? KeyOptionsReply.Options)?.creation ?: throw LostReply(StepWords.LOST_SETUP)
    }

    /*
     * Sends the key's answer. Only the server's own answer says the key was added (the core's
     * `keyAddedReplyRead`); its refusals (ten keys already, this key already added, a key that did not
     * verify, a setup that ran out) come in its own words, and each ends the setup: a registration is
     * good for one answer. `name`: null for the server's own name for the key.
     */
    fun addKey(at: Shared.Session, registrationToken: String, name: String?, registration: KeyRegistration): KeyAdded {
        val reply = Auth.requestAt(at, "/api/auth/two-step/keys", JSONObject(keyRegistrationJson(registrationToken, name, registration)))
        return when (val read = keyAddedReplyRead(status(reply.status), reply.text)) {
            is KeyAddedReply.Added -> read.key
            is KeyAddedReply.Refused -> if (reply.status == 401) throw NotAuthenticated() else throw KeyRefused(Problems.signIn(reply.status, read.message), reply.status)
            KeyAddedReply.Lost -> throw LostReply(StepWords.LOST_KEY_ADDED)
        }
    }

    /* A key's name in the list: any session may change it, and the server checks it (1 to 40 characters), in its own words. */
    fun renameMethod(at: Shared.Session, id: String, name: String): TwoStepStatus.Method {
        val body = Auth.callAt(at, "/api/auth/two-step/methods/$id", JSONObject().put("name", name.trim()), "PUT")
        return body.optJSONObject("method")?.let(TwoStepStatus::method) ?: throw LostReply(StepWords.LOST_SAVED)
    }

    /*
     * Which kind is asked for first. No password: it changes only an order. Returns the kind the server
     * now names; a 403 (a session that never passed the step) and a 404 are said in the server's words.
     */
    fun makeDefault(at: Shared.Session, kind: String): String? {
        val body = Auth.callAt(at, "/api/auth/two-step/default", JSONObject().put("kind", kind), "PUT")
        if (!body.has("defaultKind")) throw LostReply(StepWords.LOST_SAVED)
        return body.opt("defaultKind") as? String
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
