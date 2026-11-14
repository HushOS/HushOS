package com.hushos.app.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.hushos.core.PushChannel
import com.hushos.core.PushEvent
import com.hushos.core.PushEventKind
import com.hushos.core.PushLocalRelay
import com.hushos.core.PushNotice
import com.hushos.core.PushOpen
import com.hushos.core.base64urlDecode
import com.hushos.core.pushEventRead
import com.hushos.core.pushEventsRead
import com.hushos.core.pushNotice
import com.hushos.core.pushNoticeFallback
import com.hushos.core.pushRelayUsable
import com.hushos.core.pushTagMatches
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/*
 * Push notifications on this phone (docs/devices-design.md 5; docs/push-relay-plan.md, PR 4).
 *
 * The FCM token goes to the relay the server names (push.hushos.com, the core's `push_relay_usable`), which answers
 * with a handle and a deletion secret. Only the handle goes to the server. The registration is kept in the encrypted
 * preferences beside the session (`Shared.pushRegistration`): it is account data, forgotten on every wipe
 * (AccountStore). A forgotten or replaced handle waits in a pending-deletion record, outside the account's data, until
 * its relay confirms the deletion. A push is an FCM data message with an event id and a tag; PushService checks the
 * tag, fetches the event over the session and posts the notice in the core's words, or "New activity in HushOS".
 */

/* This phone's registration with the relay, for one account on one server. */
data class PushRegistration(
    val origin: String, val userId: String, val relay: String, val platform: String,
    /* The FCM token: a new one means registering again. */
    val token: String,
    val handle: String,
    /* Deletes the handle at the relay; never leaves this phone but for that. */
    val deleteSecret: String,
) {
    fun belongsTo(session: Shared.Session) = origin == session.origin && userId.equals(session.userId, ignoreCase = true)

    fun json(): JSONObject = JSONObject().put("origin", origin).put("userId", userId).put("relay", relay).put("platform", platform)
        .put("token", token).put("handle", handle).put("deleteSecret", deleteSecret)

    companion object {
        fun from(json: JSONObject): PushRegistration? = runCatching {
            PushRegistration(json.getString("origin"), json.getString("userId"), json.getString("relay"), json.getString("platform"),
                json.getString("token"), json.getString("handle"), json.getString("deleteSecret"))
        }.getOrNull()
    }
}

/* A handle waiting to be deleted at its relay, kept until the relay answers 204 or 404. */
data class PushPendingDeletion(val relay: String, val handle: String, val deleteSecret: String) {
    constructor(registration: PushRegistration) : this(registration.relay, registration.handle, registration.deleteSecret)

    fun json(): JSONObject = JSONObject().put("relay", relay).put("handle", handle).put("deleteSecret", deleteSecret)

    companion object {
        fun from(json: JSONObject): PushPendingDeletion? = runCatching {
            PushPendingDeletion(json.getString("relay"), json.getString("handle"), json.getString("deleteSecret"))
        }.getOrNull()
    }
}

/*
 * Where the registration state lives: the encrypted preferences (and, for the event ids shown, the account's files), or
 * a test's memory. The pending deletions are not account data: they outlive a sign-out until the relay has them.
 */
interface PushStore {
    fun session(): Shared.Session?
    fun read(): PushRegistration?
    fun write(registration: PushRegistration): Boolean
    fun clear()
    fun pending(): List<PushPendingDeletion>
    fun setPending(list: List<PushPendingDeletion>): Boolean
}

class SharedPushStore(private val context: Context) : PushStore {
    override fun session() = Shared.session(context)
    override fun read() = Shared.pushRegistration(context)?.let(PushRegistration::from)
    override fun write(registration: PushRegistration) = Shared.writePushRegistration(context, registration.json())
    override fun clear() = Shared.clearPushRegistration(context)
    override fun pending() = Shared.pushPending(context)?.let { list ->
        (0 until list.length()).mapNotNull { list.optJSONObject(it)?.let(PushPendingDeletion::from) }
    }.orEmpty()
    override fun setPending(list: List<PushPendingDeletion>) =
        Shared.writePushPending(context, if (list.isEmpty()) null else JSONArray(list.map { it.json() }))
}

/* An answer from the server: its status, the JSON and the text. */
internal class PushReply(val status: Int, val json: JSONObject, val text: String)

/* A request over the session, never following a redirect (one would be sent the cookie again). */
internal fun pushRequest(session: Shared.Session, path: String, method: String = "GET", body: JSONObject? = null, timeout: Int = 20_000): PushReply {
    val connection = URL(session.origin + path).openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.instanceFollowRedirects = false
    val cookieName = if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
    connection.setRequestProperty("Cookie", "$cookieName=${session.token}")
    connection.setRequestProperty("Origin", session.origin)
    connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
    connection.connectTimeout = timeout
    connection.readTimeout = timeout
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
    } finally {
        connection.disconnect()
    }
    if (status == 401) throw NotAuthenticated()
    return PushReply(status, runCatching { JSONObject(text) }.getOrDefault(JSONObject()), text)
}

internal fun pushRefusal(reply: PushReply) = PushNotifications.Refused(reply.json.optString("message").ifEmpty { Problems.SERVER })

/*
 * Registering, turning off and forgetting, one at a time. `register`, `turnOff` and `settle` hold `turn` for their whole
 * run; `forget` (called from a wipe, which must not wait on the network) moves `generation` under `state`, and every
 * write of the registration is made under `state` too, only while the session it began under is still signed in and
 * nothing forgot registrations since. So a registration never comes back after a sign-out.
 */
class PushRegistrar(
    private val store: PushStore,
    private val platform: String = PushNotifications.PLATFORM,
    private val usable: (String?) -> String? = PushNotifications::usable,
) {
    private val turn = Any()
    private val state = Any()
    private val deletions = Any()
    private var generation = 0L

    fun registration(): PushRegistration? = synchronized(state) { store.read() }

    private fun putHandle(session: Shared.Session, handle: String) {
        val reply = pushRequest(session, "/api/notifications/registration", "PUT", JSONObject().put("kind", "relay").put("handle", handle))
        if (reply.status != 200) throw pushRefusal(reply)
    }

    private fun relayRegister(relay: String, token: String): Pair<String, String> {
        val connection = URL("$relay/v1/register").openConnection() as HttpURLConnection
        val status: Int
        val text: String
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.connectTimeout = 20_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = false
            connection.outputStream.use { it.write(JSONObject().put("platform", platform).put("token", token).toString().toByteArray()) }
            status = connection.responseCode
            text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw PushNotifications.Refused("HushOS couldn’t reach its push relay. Check your connection, then try again.")
        } finally {
            connection.disconnect()
        }
        val json = runCatching { JSONObject(text) }.getOrNull()
        val handle = json?.optString("handle").orEmpty()
        val secret = json?.optString("deleteSecret").orEmpty()
        val whole = runCatching { base64urlDecode(handle).size == 32 && base64urlDecode(secret).size == 32 }.getOrDefault(false)
        if (status != 200 || !whole) throw PushNotifications.Refused("The push relay didn’t take this phone. Try again later.")
        return handle to secret
    }

    /* Whether the relay has let the handle go: 204, or 404 (already gone, or never known). Anything else is tried again later. */
    private fun relayDelete(pending: PushPendingDeletion): Boolean = runCatching {
        val connection = URL("${pending.relay}/v1/register/${pending.handle}").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "DELETE"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            connection.outputStream.use { it.write(JSONObject().put("deleteSecret", pending.deleteSecret).toString().toByteArray()) }
            connection.responseCode.let { it == 204 || it == 404 }
        } finally {
            connection.disconnect()
        }
    }.getOrDefault(false)

    /* Under `state`. */
    private fun addPending(registration: PushRegistration) {
        val list = store.pending()
        if (list.none { it.handle == registration.handle }) store.setPending(list + PushPendingDeletion(registration))
    }

    /* A handle this phone no longer uses: kept for deletion, then deleted. */
    private fun retire(registration: PushRegistration) {
        synchronized(state) { addPending(registration) }
        drain()
    }

    /* Every pending deletion tried once more; each one the relay confirms is let go. At every start and after each retirement. Blocking. */
    fun drain() = synchronized(deletions) {
        val list = synchronized(state) { store.pending() }
        val done = list.filter(::relayDelete).map { it.handle }.toSet()
        if (done.isNotEmpty()) synchronized(state) { store.setPending(store.pending().filterNot { it.handle in done }) }
    }

    /* Under `state`: the session a step began under is still the one signed in, and nothing forgot registrations since. */
    private fun stands(session: Shared.Session, began: Long) = store.session() == session && generation == began

    /*
     * The same token at the same relay sends the kept handle again (the server may have dropped it); a new token or relay
     * registers afresh. The new registration is kept before the server is told, so a stop in between leaves the handle
     * the next start sends again. A server that refuses it puts back what was kept before, but only for the same
     * session: never after a sign-out. Blocking.
     */
    fun register(token: String, relay: String) = synchronized(turn) {
        val session = store.session() ?: throw NotAuthenticated()
        val target = usable(relay) ?: throw PushNotifications.Refused("This server’s notifications can’t reach this phone.")
        val began = synchronized(state) { generation }
        val previous = synchronized(state) { store.read() }
        if (previous != null && previous.belongsTo(session) && previous.relay == target && previous.token == token && previous.platform == platform) {
            putHandle(session, previous.handle)
            return@synchronized
        }
        val (handle, secret) = relayRegister(target, token)
        val next = PushRegistration(session.origin, session.userId, target, platform, token, handle, secret)
        val kept = synchronized(state) { stands(session, began) && store.write(next) }
        if (!kept) {
            val signedIn = synchronized(state) { stands(session, began) }
            retire(next)
            throw PushNotifications.Refused(
                if (signedIn) "This phone couldn’t keep its notification settings. Try again." else "You signed out before notifications were turned on.",
            )
        }
        try {
            putHandle(session, handle)
        } catch (error: Exception) {
            val restored = synchronized(state) {
                when {
                    !stands(session, began) -> false
                    previous == null || !previous.belongsTo(session) -> { store.clear(); false }
                    else -> store.write(previous)
                }
            }
            // What was overwritten and not put back would otherwise be nobody's to delete.
            if (!restored && previous != null) retire(previous)
            retire(next)
            throw error
        }
        if (previous != null) retire(previous)
    }

    /* "On this phone" off: the server stops pinging this device, then the handle is forgotten here and deleted at the relay. */
    fun turnOff() = synchronized(turn) {
        val session = store.session() ?: throw NotAuthenticated()
        val reply = pushRequest(session, "/api/notifications/registration", "DELETE", JSONObject())
        if (reply.status != 200) throw pushRefusal(reply)
        val kept = synchronized(state) {
            store.read()?.takeIf { store.session() == session && it.belongsTo(session) }?.also { store.clear() }
        }
        if (kept != null) retire(kept)
    }

    /* A server that names no relay now, or another one: the kept registration can never be reached or turned off from there, so it goes. */
    fun settle(relay: String?) = synchronized(turn) {
        val session = store.session() ?: return@synchronized
        val kept = synchronized(state) { store.read() }?.takeIf { it.belongsTo(session) && it.relay != relay } ?: return@synchronized
        runCatching { pushRequest(session, "/api/notifications/registration", "DELETE", JSONObject()) }
        val gone = synchronized(state) { (store.session() == session && store.read() == kept).also { if (it) store.clear() } }
        if (gone) retire(kept)
    }

    /* Every wipe: forgotten here at once and held for deletion. True when there was one (the caller then drains, off this thread). */
    fun forget(): Boolean = synchronized(state) {
        generation++
        val kept = store.read()
        store.clear()
        if (kept != null) addPending(kept)
        kept != null
    }
}

object PushNotifications {
    /* The two kinds a person can turn off; security notices always come. */
    data class Toggles(val shared: Boolean, val family: Boolean)

    /* The server's toggles, and the relay this phone may register with (null: no pushes to phones). */
    data class ServerState(val toggles: Toggles, val relay: String?)

    class Refused(message: String) : Exception(message)

    const val PLATFORM = "fcm"

    /* push.hushos.com; in a debug build also a relay on this computer, by 10.0.2.2 only from the emulator. */
    fun usable(relay: String?): String? = pushRelayUsable(relay, when {
        !com.hushos.app.BuildConfig.DEBUG -> PushLocalRelay.NONE
        onEmulator() -> PushLocalRelay.THIS_COMPUTER_FROM_EMULATOR
        else -> PushLocalRelay.THIS_COMPUTER
    })

    private fun onEmulator(): Boolean = runCatching {
        android.os.Build.HARDWARE in setOf("ranchu", "goldfish") || android.os.Build.FINGERPRINT.startsWith("generic") ||
            android.os.Build.PRODUCT.startsWith("sdk_") || android.os.Build.PRODUCT.contains("emulator")
    }.getOrDefault(false)

    @Volatile private var shared: PushRegistrar? = null

    /* One per process, so `forget` and a registration under way share their lock and generation. */
    fun registrar(context: Context): PushRegistrar = shared ?: synchronized(this) {
        shared ?: PushRegistrar(SharedPushStore(context.applicationContext)).also { shared = it }
    }

    fun registration(context: Context): PushRegistration? = registrar(context).registration()

    private fun state(json: JSONObject): ServerState {
        val settings = json.optJSONObject("settings") ?: throw Refused("Your notification settings couldn’t be read. Try again.")
        if (!settings.has("shared") || !settings.has("family")) throw Refused("Your notification settings couldn’t be read. Try again.")
        // A server from before `relay` names none: nothing would reach this phone.
        val relay = if (json.has("relay") && !json.isNull("relay")) json.optString("relay") else null
        return ServerState(Toggles(settings.getBoolean("shared"), settings.getBoolean("family")), usable(relay))
    }

    /*
     * The server's settings and relay; null when it has notifications off (501 `off`). A server naming no relay now, or
     * another one, lets go of the registration kept for the old one. Blocking.
     */
    fun serverState(context: Context): ServerState? {
        val session = Shared.session(context) ?: throw NotAuthenticated()
        val reply = pushRequest(session, "/api/notifications/settings")
        if (reply.status == 501 && reply.json.optString("code") == "off") return null
        if (reply.status != 200) throw pushRefusal(reply)
        return state(reply.json).also { registrar(context).settle(it.relay) }
    }

    fun save(context: Context, toggles: Toggles): Toggles {
        val session = Shared.session(context) ?: throw NotAuthenticated()
        val reply = pushRequest(session, "/api/notifications/settings", "PUT", JSONObject().put("shared", toggles.shared).put("family", toggles.family))
        if (reply.status != 200) throw pushRefusal(reply)
        return state(reply.json).toggles
    }

    fun register(context: Context, token: String, relay: String) = registrar(context).register(token, relay)

    fun turnOff(context: Context) {
        registrar(context).turnOff()
        PushTokens.stop(context)
    }

    /*
     * Every wipe of the account on this phone (sign-out, deletion, a removal, another account in): forgotten here at once,
     * deleted at the relay with its secret on a thread of its own and retried at every start until the relay confirms,
     * the notices it posted taken down, and the FCM token deleted. The server already dropped its row with the device.
     */
    fun forget(context: Context) {
        val registrar = registrar(context)
        val had = registrar.forget()
        PushNotices.clear(context)
        if (!had) return
        PushTokens.stop(context)
        Thread({ registrar.drain() }, "HushOSPushForget").start()
    }

    /* At every start: handles still waiting to be deleted at their relay. Off the main thread. */
    fun retryDeletions(context: Context) {
        val registrar = registrar(context)
        Thread({ registrar.drain() }, "HushOSPushRetry").start()
    }

    /* Event ids this phone has shown, so the catch-up never shows one twice (filesDir, wiped with the account). */
    const val SEEN = "push-seen.json"
    private const val SEEN_KEPT = 500

    @Synchronized
    internal fun markSeen(context: Context, ids: List<String>) {
        if (ids.isEmpty()) return
        val seen = seen(context).toMutableList()
        ids.filterNot { it in seen }.forEach { seen += it }
        runCatching { File(context.filesDir, SEEN).writeText(JSONArray(seen.takeLast(SEEN_KEPT)).toString()) }
    }

    @Synchronized
    internal fun seen(context: Context): List<String> = runCatching {
        JSONArray(File(context.filesDir, SEEN).readText()).let { list -> (0 until list.length()).map { list.getString(it) } }
    }.getOrDefault(emptyList())

    /* A lowercase UUID, the only id that goes into a path. */
    internal fun isEventId(id: String): Boolean = id.length == 36 && id == id.lowercase() && runCatching { java.util.UUID.fromString(id) }.isSuccess

    /*
     * The notice for a push's data (`id`, `tag`): the event fetched over the session and put in the core's words, or
     * the fallback whenever anything doesn't hold (a tag that isn't this registration's, another account signed in, a
     * fetch that fails, an event gone). An event read is marked seen. Blocking: PushService runs it under its deadline.
     */
    fun notice(context: Context, data: Map<String, String>): PushNotice {
        val id = data["id"] ?: return pushNoticeFallback()
        val tag = data["tag"] ?: return pushNoticeFallback()
        val session = Shared.session(context) ?: return pushNoticeFallback()
        val kept = registration(context)?.takeIf { it.belongsTo(session) } ?: return pushNoticeFallback()
        if (!isEventId(id) || !pushTagMatches(kept.handle, tag)) return pushNoticeFallback()
        return runCatching {
            val reply = pushRequest(session, "/api/notifications/$id", timeout = 8_000)
            if (reply.status != 200) return pushNoticeFallback()
            val event = pushEventRead(reply.text, id)
            markSeen(context, listOf(id))
            // Another device is asking this one to confirm it's you: an app that is open reads its requests now (ApprovalPushes).
            if (event.kind == PushEventKind.APPROVAL_REQUEST) ApprovalPushes.arrived()
            pushNotice(event, sender(context, event, session))
        }.getOrElse { pushNoticeFallback() }
    }

    /*
     * When the app opens or comes back, signed in: what the server holds for this device that no push showed
     * (`GET /api/notifications`, which also answers the device's open ping, so later events are not held back as
     * coalesced). Only while this phone has notifications on for the account. Unseen events come back in the core's
     * words, at most the last ten; every one listed is marked seen. Blocking.
     */
    fun catchUp(context: Context): List<Pair<String, PushNotice>> {
        val session = Shared.session(context) ?: return emptyList()
        if (registration(context)?.belongsTo(session) != true) return emptyList()
        val events = mutableListOf<PushEvent>()
        for (page in 0 until 5) {
            val reply = runCatching { pushRequest(session, "/api/notifications") }.getOrNull()?.takeIf { it.status == 200 } ?: break
            val read = runCatching { pushEventsRead(reply.text) }.getOrNull() ?: break
            events += read.events
            if (!read.more) break
        }
        val seen = seen(context).toSet()
        val unseen = events.filterNot { it.id in seen }.distinctBy { it.id }
        markSeen(context, events.map { it.id })
        return unseen.takeLast(10).map { it.id to pushNotice(it, sender(context, it, session)) }
    }

    /*
     * The sharer's name, only from a pin this person verified by words themselves (the web's rule: verified, not trusted
     * through a family, and its own name, never the address). Anyone else, or settings that don't open, is nobody.
     */
    private fun sender(context: Context, event: PushEvent, session: Shared.Session): String? {
        if (event.kind != PushEventKind.SHARED) return null
        val userId = event.granterUserId ?: return null
        return runCatching {
            val vault = Vault.fromShared(context)?.takeIf { it.api.session == session } ?: return null
            vault.loadSettings().contacts.values.firstOrNull { it.userId.equals(userId, ignoreCase = true) }
                ?.takeIf { it.trustedVia == null && it.verified }?.name?.takeIf { it.isNotBlank() }
        }.getOrNull()
    }
}

/*
 * Posting the notices. Three channels a person can tune in Settings (security, shared, families) and a quiet one for
 * the fallback. Every notice, and every channel, is VISIBILITY_PRIVATE, with a public version reading "New activity in
 * HushOS", and stays on this phone (never bridged to a watch).
 *
 * What a locked phone shows is the person's choice in Android's settings, not the app's: with "Show sensitive content"
 * (or "Show all notification content") on the lock screen, which many phones have by default, Android shows the
 * private version there; with it off, only the public version shows until the phone is unlocked. iOS's default
 * ("Show Previews: When Unlocked") is the second. An app cannot force it: VISIBILITY_SECRET would hide the notice from
 * the lock screen altogether, which the design rules out (every ping is seen).
 */
object PushNotices {
    const val SECURITY = "push-security"
    const val SHARED = "push-shared"
    const val FAMILIES = "push-families"
    const val OTHER = "push-other"
    private val CHANNELS = listOf(SECURITY, SHARED, FAMILIES, OTHER)

    /* What a tapped notice opens: MainActivity's action, the screen's request. */
    const val OPEN = "com.hushos.app.push.OPEN"

    fun channels(context: Context) {
        val system = context.getSystemService(NotificationManager::class.java) ?: return
        system.createNotificationChannels(listOf(
            NotificationChannel(SECURITY, "Security", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New sign-ins, removed devices, password attempts and changes to two-step sign-in"
            },
            NotificationChannel(SHARED, "Shared with you", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When someone shares something with you"
            },
            NotificationChannel(FAMILIES, "Families", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Invitations, and people waiting to join your family"
            },
            NotificationChannel(OTHER, "Other activity", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Activity HushOS couldn’t read on this phone"
            },
        ).onEach { it.lockscreenVisibility = Notification.VISIBILITY_PRIVATE })
    }

    /* `event`: the event a notice is about, so a catch-up that finds it again replaces it rather than adding one. */
    fun post(context: Context, notice: PushNotice, event: String? = null) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        channels(context)
        val channel = when (notice.channel) {
            PushChannel.SECURITY -> SECURITY
            PushChannel.SHARED -> SHARED
            PushChannel.FAMILIES -> FAMILIES
            PushChannel.OTHER -> OTHER
        }
        val open = when (notice.open) {
            PushOpen.DEVICES -> "devices"
            PushOpen.ACCOUNT -> "account"
            PushOpen.SHARED -> "shared:false"
            PushOpen.FAMILIES -> "families"
            PushOpen.APP -> "app"
        }
        val id = event?.hashCode() ?: (System.nanoTime() % Int.MAX_VALUE).toInt()
        val tap = PendingIntent.getActivity(
            context, id,
            Intent(context, com.hushos.app.MainActivity::class.java).setAction("$OPEN:$open").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val fallback = com.hushos.core.pushFallbackText()
        // The fallback is a body alone on iOS; here it is the title, so the line Android draws first isn't empty.
        val title = notice.title.ifEmpty { notice.body }
        val text = notice.body.takeIf { notice.title.isNotEmpty() }
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(com.hushos.app.R.drawable.icon_monochrome)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(text?.let { NotificationCompat.BigTextStyle().bigText(it) })
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setCategory(if (notice.channel == PushChannel.SECURITY) NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_SOCIAL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, channel)
                .setSmallIcon(com.hushos.app.R.drawable.icon_monochrome)
                .setContentTitle(fallback)
                .setLocalOnly(true)
                .build())
            .setLocalOnly(true)
        runCatching { manager.notify(id, builder.build()) }
    }

    /* Sign-out and every wipe: notices that may name a contact go with the account. */
    fun clear(context: Context) {
        runCatching {
            val system = context.getSystemService(NotificationManager::class.java)
            system.activeNotifications.filter { it.notification.channelId in CHANNELS }.forEach { system.cancel(it.id) }
        }
    }
}
