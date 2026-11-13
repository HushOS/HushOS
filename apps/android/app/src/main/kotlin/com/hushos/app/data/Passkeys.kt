package com.hushos.app.data

import android.content.Context
import com.hushos.app.BuildConfig
import com.hushos.core.KeyAssertion
import com.hushos.core.KeyCreation
import com.hushos.core.KeyRegistration
import com.hushos.core.StepChallenge
import com.hushos.core.StepKeyRequest
import com.hushos.core.StepMethod
import com.hushos.core.stepMethodsNamed
import com.hushos.core.stepMethodsRefused

/*
 * A passkey or security key as the second step (docs/two-step-design.md 3 and 12): which server
 * this app can use one for, what it tells a server it can answer, what the step screen holds while
 * one is the way shown, and the rules for adding and naming one. The system's sheet itself is
 * `ui/PasskeySheet.kt`; everything here runs without it, so it is tested (`PasskeysTest`).
 */
object Passkeys {
    /* The most keys an account can have. */
    const val LIMIT = 10

    /*
     * Whether this app can use a passkey or security key for `serverOrigin`: over https, and only on
     * the host its links are verified for (`appLinkHost` in the build; hushos.com for the store app).
     * That host's `assetlinks.json` is what lets Android hand this app a key bound to it. For any
     * other server the app names no methods, and its keys are added in a browser.
     */
    fun usable(serverOrigin: String, linkHost: String = BuildConfig.LINK_HOST): Boolean {
        val uri = runCatching { java.net.URI(serverOrigin.trim()) }.getOrNull() ?: return false
        val host = uri.host ?: return false
        // As the iPhone app has it: a port other than 443 is another origin to the server, and an
        // address with a user or password in it is not one a person typed for this host.
        return uri.scheme.equals("https", ignoreCase = true) && linkHost.isNotEmpty() && host.equals(linkHost, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) && uri.rawUserInfo == null
    }
}

/*
 * The phone's own sheet for a passkey or security key. Null: the sheet was closed, or no key
 * answered. Nothing was sent then, and whatever asked is still there to ask again. Each is called
 * only from the press that sends its answer, never when a screen appears.
 */
interface KeySheet {
    suspend fun assertion(request: StepKeyRequest): KeyAssertion?
    suspend fun registration(creation: KeyCreation): KeyRegistration?
}

/* A key was the way shown, and none answered: refused on this phone, before anything was sent. */
class KeyUnused(message: String = StepWords.PASSKEY_UNUSED) : AuthFailure(message)

/* `two-step/keys` refused the key, in the server's words. The registration is used up: the setup starts again from the password. */
class KeyRefused(message: String, status: Int) : AuthFailure(message, status)

/*
 * Whether a server said it reads `twoStepMethods`, as of this phone's last sign-in there. Kept per
 * server across launches: a session lasts 30 days, and its changes name methods too. Three states:
 * said so (true), said nothing (false), and never heard (null: a session from before this version).
 *
 * "Said nothing" is kept for a day and no longer (`NO_MS`). A server is updated while sessions on
 * it live on, and a session that went on believing the old answer would never be offered its
 * passkey at a change. After a day it is never heard again: the field is tried once more.
 */
interface StepAdverts {
    fun read(origin: String): Boolean?
    fun write(origin: String, advertised: Boolean)

    /* In memory: for tests, and for a caller with nowhere to keep it. */
    class Memory(private val now: () -> Long = System::currentTimeMillis) : StepAdverts {
        private val said = mutableMapOf<String, Any>()
        @Synchronized override fun read(origin: String): Boolean? = heard(said[key(origin)], now())
        @Synchronized override fun write(origin: String, advertised: Boolean) { said[key(origin)] = kept(advertised, now()) }
    }

    companion object {
        /* How long "does not read it" is believed. */
        const val NO_MS = 24L * 60 * 60 * 1000

        /* One server, however its address was typed. */
        internal fun key(origin: String): String = origin.trim().trimEnd('/').lowercase()

        /* What is kept for an answer: `true`, or when the server was found not to read the field. */
        internal fun kept(advertised: Boolean, now: Long): Any = if (advertised) true else now

        /* What a kept value says now. A time from the future is a clock that moved: not trusted, and tried again. */
        internal fun heard(kept: Any?, now: Long): Boolean? = when (kept) {
            true -> true
            is Number -> if (now >= kept.toLong() && now - kept.toLong() < NO_MS) false else null
            else -> null
        }

        /* Beside the session and the server's address, in the app's encrypted preferences. */
        fun stored(context: Context, now: () -> Long = System::currentTimeMillis): StepAdverts = object : StepAdverts {
            private val app = context.applicationContext
            override fun read(origin: String): Boolean? = heard(Shared.stepAdvert(app, key(origin)), now())
            override fun write(origin: String, advertised: Boolean) = Shared.writeStepAdvert(app, key(origin), kept(advertised, now()))
        }
    }
}

/*
 * `twoStepMethods`: what this build tells a server it can answer beyond codes and the phrase. It is
 * sent only to a server that reads it. A release from before passkeys has a schema that takes
 * `twoStep: 1` and nothing else, so that field is never changed, and this one is held back from a
 * server that never advertised it.
 */
object StepNames {
    /* What this phone names for `origin`: a passkey or security key only where it can use one. */
    fun named(origin: String, linkHost: String = BuildConfig.LINK_HOST): List<String> = stepMethodsNamed(Passkeys.usable(origin, linkHost))

    /*
     * `login/finish`. `advertised` is what this sign-in's own `login/start` reply said. A rolling
     * update can answer the two from different releases: refused by a schema (`stepMethodsRefused`),
     * nothing was looked at and the attempt is still good, so the same request goes once more
     * without the field.
     */
    internal fun <R> atSignIn(advertised: Boolean, status: (R) -> Int, send: (named: Boolean) -> R): R {
        if (!advertised) return send(false)
        val first = send(true)
        return if (stepMethodsRefused(status(first).toUShort())) send(false) else first
    }

    /*
     * `two-step/challenge`, under a session that may be a month old. The field goes to a server that
     * advertised it, and to one never heard from (a session from before this version: a passkey added
     * from it must be able to answer the next change). Refused, it is asked once more without, and the
     * server is remembered as one that does not read it. Not when the second ask is refused the same
     * way: then the field was not what the server minded.
     */
    internal fun <R> atChange(adverts: StepAdverts, origin: String, status: (R) -> Int, send: (named: Boolean) -> R): R {
        if (adverts.read(origin) == false) return send(false)
        val first = send(true)
        if (!stepMethodsRefused(status(first).toUShort())) return first
        val second = send(false)
        if (!stepMethodsRefused(status(second).toUShort())) adverts.write(origin, false)
        return second
    }
}

/*
 * The step as this phone offers it. A passkey or security key is offered only with something to ask
 * it (the step's own challenge) and only where this phone can use one: listed without either, it is
 * left out, and the rest stay in the server's order.
 */
fun StepChallenge.offered(passkeys: Boolean): StepChallenge =
    if (StepMethod.WEBAUTHN in methods && (keyRequest == null || !passkeys)) copy(methods = methods.filter { it != StepMethod.WEBAUTHN }, keyRequest = null)
    else this

/*
 * The one line a step says above its fields when the server left something out
 * (docs/two-step-design.md 12). Never the reason: someone who has only the password learns nothing
 * about the owner's devices from it. One or the other, never both.
 * - A way was left out though this phone named every kind it knows: a newer HushOS has it.
 * - Otherwise the account's usual way is not first: it can't be used here, whyever.
 */
object StepNote {
    const val UPDATE = "Update HushOS to use your passkey or another device."
    const val USUAL_SIGN_IN = "Your usual way isn’t available for this sign-in."
    const val USUAL_CHANGE = "Your usual way isn’t available for this change."

    /* `passkeys`: whether this phone named a passkey or security key to this server. Empty when there is nothing to say. */
    fun of(challenge: StepChallenge, passkeys: Boolean, change: Boolean): String = when {
        challenge.withheld && passkeys -> UPDATE
        challenge.defaultUnavailable -> if (change) USUAL_CHANGE else USUAL_SIGN_IN
        else -> ""
    }
}

/*
 * The second step of a sign-in, as its screen holds it: what is offered, what was typed, what was
 * said about the last answer, and an answer whose reply was lost. Decided here, away from the
 * screen: it opens on the server's first method, nothing asks a key until the press that sends its
 * answer, and a key that did not answer sends nothing and leaves the step as it was. Immutable:
 * every change is a new value.
 */
data class SignInStep(
    val challenge: StepChallenge,
    val methods: List<StepMethod> = challenge.methods,
    val draft: StepDraft = StepDraft.of(challenge.methods),
    /* The field's own complaint, or the key's. */
    val fieldError: String = "",
    /* What the server, or a lost reply, said: above the field. */
    val notice: String = "",
    /* The last reply was lost: the same answer goes again. */
    val lost: StepAnswer? = null,
) {
    val shown: StepMethod? get() = draft.shown(methods)

    fun typed(next: StepDraft) = copy(draft = next, fieldError = "", lost = null)

    /* The one button's words. A key has no field, so its button says what the press does. */
    fun button(busy: Boolean): String = when {
        busy -> "Checking"
        lost != null -> "Try again"
        shown == StepMethod.WEBAUTHN -> "Use your passkey"
        else -> "Continue"
    }

    /* What a press came to: an answer to send, or the step as it stays (with why, if there is a why). */
    sealed class Pressed {
        data class Send(val step: SignInStep, val answer: StepAnswer) : Pressed()
        data class Stay(val step: SignInStep) : Pressed()
    }

    /* The press. The only place a key is asked; a cancelled press is thrown on, with nothing sent. */
    suspend fun pressed(sheet: KeySheet): Pressed {
        val method = shown ?: return Pressed.Stay(this)
        lost?.let { return Pressed.Send(copy(fieldError = "", notice = ""), it) }
        draft.problem(method)?.let { return Pressed.Stay(copy(fieldError = it)) }
        val answer = try {
            draft.proved(challenge, method, sheet)
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Exception) {
            // A mistyped phrase, or a key that did not answer: refused here, before anything is sent.
            return Pressed.Stay((StepOutcome.after(error, methods) as? StepOutcome.Again)?.let { copy(fieldError = it.message) } ?: this)
        }
        return Pressed.Send(copy(fieldError = "", notice = ""), answer)
    }

    /* The press, with the sending: `send` is called only with an answer. */
    suspend fun press(sheet: KeySheet, send: (SignInStep, StepAnswer) -> Unit): SignInStep = when (val pressed = pressed(sheet)) {
        is Pressed.Stay -> pressed.step
        is Pressed.Send -> pressed.step.also { send(it, pressed.answer) }
    }

    /* What the server made of `answer` (null: signed in, or the step is over and the view model has moved on). */
    fun after(outcome: StepOutcome?, answer: StepAnswer): SignInStep = when (outcome) {
        is StepOutcome.Again -> copy(lost = null, methods = outcome.methods, fieldError = if (outcome.field) outcome.message else fieldError, notice = if (outcome.field) notice else outcome.message)
        is StepOutcome.Retry -> copy(notice = outcome.message, lost = answer)
        is StepOutcome.Over, null -> copy(lost = null)
    }
}

/* A key's name: the person's own word for it, shown in the list only. The server checks it again. */
object KeyName {
    const val MAX = 40
    const val EMPTY = "Enter a name."
    const val TOO_LONG = "Use no more than 40 characters."

    /* Characters as a person counts them, not UTF-16 units: the web's `Array.from(name).length`. */
    private fun length(name: String) = name.codePointCount(0, name.length)

    /* Why a rename can't be saved; null when it can. */
    fun problem(name: String): String? = name.trim().let { if (it.isEmpty()) EMPTY else if (length(it) > MAX) TOO_LONG else null }

    /* A name given while adding a key is optional: only its length can be wrong. */
    fun tooLong(name: String): Boolean = length(name.trim()) > MAX
}

/*
 * The press that adds a key: the name is checked first, then the phone's sheet is asked, and only
 * a key that answered is sent. A closed sheet sends nothing, and the same setup stands.
 */
object KeySetup {
    sealed class Pressed {
        /* `name`: null when none was given, and the server names the key. */
        data class Send(val registration: KeyRegistration, val name: String?) : Pressed()
        data class Stay(val error: String) : Pressed()
    }

    suspend fun pressed(creation: KeyCreation, name: String, sheet: KeySheet): Pressed {
        if (KeyName.tooLong(name)) return Pressed.Stay(KeyName.TOO_LONG)
        val registration = sheet.registration(creation) ?: return Pressed.Stay(StepWords.PASSKEY_NOT_ADDED)
        return Pressed.Send(registration, name.trim().ifEmpty { null })
    }
}
