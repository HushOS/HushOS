package com.hushos.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File

/*
 * Asking once (docs/devices-design.md 5, Settings): right after a sign-in or sign-up, or at the first signed-in start of
 * a build that asks, on a server with notifications and a relay this app can use, the app asks for POST_NOTIFICATIONS
 * (Android 13 and later) and, if allowed, turns "On this phone" on as the switch does. Where notifications are allowed
 * already (before Android 13, allowed for the switch and switched off since, or before signing out and back in), the app
 * can't tell a yes from an earlier "off", so it asks in its own words instead, once, and only a tap on Turn on registers.
 *
 * Once per account on a server: the record is `push-asked.json` in the app's files, wiped with the account's data
 * (AccountStore), and marked before the question, so a question the person dismissed, or an app stopped mid-question, is
 * never asked again by itself.
 */
object PushAsk {
    const val FILE = "push-asked.json"

    /* What the record says of an account on a server. None: nothing was asked yet. */
    enum class Mark {
        /* The app asked, or is about to: never again by itself. */
        ASKED,
        /* The person allowed it, but the registration didn't go through: made at the next start, with no question. */
        RETRY,
        /* The person used Account's switch: the app never asks or registers by itself after that. */
        DECIDED,
    }

    /* What Android says of HushOS's notifications, as far as asking goes. */
    enum class Permission {
        /* Android 13 and later, not granted: its question is asked (it answers at once, with no screen, when the person said no for good). */
        UNDECIDED,
        /* Granted, or notifications on before Android 13. */
        ALLOWED,
        /* Before Android 13, notifications turned off for HushOS in Settings: there is no question to ask. */
        DENIED,
    }

    /* ASK: Android's question. OFFER: the app's own (allowed already), registering on Turn on. REGISTER: a retry. */
    enum class Step { NOTHING, ASK, OFFER, REGISTER, MARK_ONLY }

    /*
     * The one decision. Nothing while this build has no notifications, this phone already has a registration for the
     * account, the server has no relay this app can use (asked once it has one: nothing was asked yet), or the record
     * says asked or decided.
     */
    fun step(available: Boolean, registered: Boolean, mark: Mark?, relay: String?, permission: Permission): Step = when {
        !available || registered || relay == null -> Step.NOTHING
        mark == Mark.ASKED || mark == Mark.DECIDED -> Step.NOTHING
        mark == Mark.RETRY -> if (permission == Permission.ALLOWED) Step.REGISTER else Step.MARK_ONLY
        permission == Permission.UNDECIDED -> Step.ASK
        permission == Permission.ALLOWED -> Step.OFFER
        else -> Step.MARK_ONLY
    }

    private fun key(session: Shared.Session) = session.origin + "\n" + session.userId.lowercase()

    /*
     * The record, one file of marks by server and account. Every change is a compare-and-set under one lock, so the
     * app's own asking and Account's switch never overwrite each other's answer.
     */
    class Record(private val file: File) {
        constructor(context: Context) : this(File(context.filesDir, FILE))

        fun mark(session: Shared.Session): Mark? = synchronized(LOCK) { read()[key(session)] }

        /* Sets [mark] only while the account's mark is still [expected]; true when it did. */
        fun set(session: Shared.Session, mark: Mark, expected: Mark?): Boolean = synchronized(LOCK) {
            val marks = read()
            if (marks[key(session)] != expected) return false
            write(marks + (key(session) to mark))
            true
        }

        /* Account's switch, either way: the person decided, so the app does nothing by itself again. */
        fun decided(session: Shared.Session) = synchronized(LOCK) { write(read() + (key(session) to Mark.DECIDED)) }

        private fun read(): Map<String, Mark> = runCatching {
            val json = JSONObject(file.readText())
            json.keys().asSequence().mapNotNull { name -> runCatching { name to Mark.valueOf(json.getString(name)) }.getOrNull() }.toMap()
        }.getOrDefault(emptyMap())

        private fun write(marks: Map<String, Mark>) {
            runCatching {
                file.parentFile?.mkdirs()
                val temporary = File(file.parentFile, "$FILE.tmp")
                temporary.writeText(JSONObject(marks.mapValues { it.value.name }).toString())
                if (!temporary.renameTo(file)) temporary.delete()
            }
        }

        private companion object {
            val LOCK = Any()
        }
    }

    /* Whether this start has already taken a retry. */
    @Volatile
    var retried = false

    /* Moves when the asking turned notifications on, so Account's switch reads again. */
    private val moved = MutableStateFlow(0)
    val changed: StateFlow<Int> = moved

    /* What was read before deciding: the account, its mark then, and the server's relay. */
    data class Reading(val session: Shared.Session, val mark: Mark?, val relay: String)

    /*
     * Reads, changing nothing: the account signed in, its mark, and the relay the server names. Null when there is nothing
     * to do (no notifications in this build, a registration already, asked or decided, no usable relay, the account
     * changed meanwhile). Blocking (it reads the server's settings).
     */
    fun read(context: Context): Reading? {
        val session = Shared.session(context) ?: return null
        if (!PushTokens.configured || PushNotifications.registration(context)?.belongsTo(session) == true) return null
        val mark = Record(context).mark(session)
        if (mark == Mark.ASKED || mark == Mark.DECIDED) return null
        // A retry once per start: this runs whenever the screen gets the focus back.
        if (mark == Mark.RETRY && retried) return null
        val relay = runCatching { PushNotifications.serverState(context)?.relay }.getOrNull() ?: return null
        if (Shared.session(context) != session) return null
        return Reading(session, mark, relay)
    }

    fun permission(context: Context): Permission = when {
        PushTokens.allowed(context) -> Permission.ALLOWED
        android.os.Build.VERSION.SDK_INT >= 33 -> Permission.UNDECIDED
        else -> Permission.DENIED
    }

    /*
     * Registers as the switch's turn-on does, quietly. A failure while notifications are allowed leaves a retry for the
     * next start, unless the switch decided meanwhile. Blocking.
     */
    fun register(context: Context, session: Shared.Session, relay: String) {
        runCatching { PushNotifications.register(context, PushTokens.token(context), relay) }
            .onSuccess { moved.value++ }
            .onFailure { if (PushTokens.allowed(context)) Record(context).set(session, Mark.RETRY, Mark.ASKED) }
    }
}
