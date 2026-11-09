package com.hushos.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import java.io.File

/*
 * Asking once (docs/devices-design.md 5, Settings): right after a sign-in or sign-up, or at the first signed-in start of
 * a build that asks, on a server with notifications and a relay this app can use, the app asks for POST_NOTIFICATIONS
 * (Android 13 and later; older Android has nothing to ask) and, if allowed, turns "On this phone" on as the switch does.
 * Once per account on a server: the record is `push-asked.json` in the app's files, wiped with the account's data
 * (AccountStore), and written before the question, so a question the person dismissed, or an app stopped mid-question,
 * is never asked again by itself. The Account switch marks it too, so a person who turned notifications off there never
 * has them turned back on.
 */
object PushAsk {
    const val FILE = "push-asked.json"

    /* What Android says of HushOS's notifications, as far as asking goes. */
    enum class Permission {
        /* Android 13 and later, not granted: its question is asked (it answers at once, with no screen, when the person said no for good). */
        UNDECIDED,
        /* Granted, or notifications on before Android 13: registered at once, with no question. */
        ALLOWED,
        /* Before Android 13, notifications turned off for HushOS in Settings: there is no question to ask. */
        DENIED,
    }

    enum class Step { NOTHING, ASK, REGISTER, MARK_ONLY }

    /*
     * The one decision. Nothing while this build has no notifications, this phone already has a registration for the
     * account, it was asked before, or the server has no relay this app can use (asked once it has one: nothing was
     * asked yet).
     */
    fun step(available: Boolean, registered: Boolean, asked: Boolean, relay: String?, permission: Permission): Step = when {
        !available || registered || asked || relay == null -> Step.NOTHING
        permission == Permission.UNDECIDED -> Step.ASK
        permission == Permission.ALLOWED -> Step.REGISTER
        else -> Step.MARK_ONLY
    }

    private fun key(session: Shared.Session) = session.origin + "\n" + session.userId.lowercase()

    @Synchronized
    fun asked(context: Context, session: Shared.Session): Boolean = key(session) in read(context)

    @Synchronized
    fun markAsked(context: Context, session: Shared.Session) {
        val asked = read(context)
        if (key(session) in asked) return
        runCatching { File(context.filesDir, FILE).writeText(JSONArray(asked + key(session)).toString()) }
    }

    private fun read(context: Context): List<String> = runCatching {
        JSONArray(File(context.filesDir, FILE).readText()).let { list -> (0 until list.length()).map { list.getString(it) } }
    }.getOrDefault(emptyList())

    /* Moves when the asking turned notifications on, so Account's switch reads again. */
    private val moved = MutableStateFlow(0)
    val changed: StateFlow<Int> = moved

    data class Decision(val step: Step, val relay: String?)

    /*
     * Decides for the account signed in and, for any step but nothing, marks it asked before anything is asked. Blocking
     * (it reads the server's settings).
     */
    fun decide(context: Context): Decision {
        val session = Shared.session(context) ?: return Decision(Step.NOTHING, null)
        val registered = PushNotifications.registration(context)?.belongsTo(session) == true
        if (!PushTokens.configured || registered || asked(context, session)) return Decision(Step.NOTHING, null)
        val relay = runCatching { PushNotifications.serverState(context)?.relay }.getOrNull()
        if (Shared.session(context) != session) return Decision(Step.NOTHING, null)
        val permission = when {
            PushTokens.allowed(context) -> Permission.ALLOWED
            android.os.Build.VERSION.SDK_INT >= 33 -> Permission.UNDECIDED
            else -> Permission.DENIED
        }
        val step = step(available = true, registered = false, asked = false, relay = relay, permission = permission)
        if (step != Step.NOTHING) markAsked(context, session)
        return Decision(step, relay)
    }

    /* Registers as the switch's turn-on does, quietly: a failure leaves the switch off, to be turned on in Account. Blocking. */
    fun register(context: Context, relay: String) {
        runCatching { PushNotifications.register(context, PushTokens.token(context), relay) }.onSuccess { moved.value++ }
    }
}
