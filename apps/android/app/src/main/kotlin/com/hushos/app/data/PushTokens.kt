package com.hushos.app.data

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.hushos.app.BuildConfig
import com.hushos.core.PushNotice
import com.hushos.core.pushNoticeFallback
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/*
 * Firebase Cloud Messaging, and nothing else of Firebase: no google-services.json and no Google Services Gradle
 * plugin. The app is set up from the build's own configuration (BuildConfig.FIREBASE_*, from Gradle properties; a
 * project id, an app id, an API key and a sender id, which are configuration, not secrets), so the open-source build
 * works without them and simply has no phone notifications. FirebaseInitProvider is removed in the manifest and FCM's
 * auto-init is off, so nothing reaches Google until the person turns "On this phone" on. Datatransport's `cct`
 * backend is unregistered (as for the document scanner), so FCM's delivery metrics are never sent.
 */
object PushTokens {
    /* This build carries a Firebase app to register with. */
    val configured: Boolean
        get() = listOf(BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_SENDER_ID)
            .all { it.isNotEmpty() }

    /* The default Firebase app, made once per process from the build's options; null in a build without them. */
    @Synchronized
    fun app(context: Context): FirebaseApp? {
        if (!configured) return null
        FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }?.let { return it }
        val options = FirebaseOptions.Builder()
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build()
        return runCatching { FirebaseApp.initializeApp(context.applicationContext, options) }.getOrNull()
    }

    /*
     * Token work one step at a time, in the order asked: a stop (turned off, or a sign-out) runs to its end before a
     * later turn-on asks for a token, so a quick off-then-on never registers a token about to be deleted.
     */
    private val steps = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "HushOSPushTokens") }

    /* The FCM token, asked for now, after any stop asked before it (blocking; off the main thread). Its renewals then reach PushService.onNewToken. */
    fun token(context: Context): String {
        app(context) ?: throw PushNotifications.Refused("This build of HushOS can’t receive notifications.")
        val token = runCatching {
            steps.submit<String> {
                val messaging = FirebaseMessaging.getInstance()
                messaging.isAutoInitEnabled = true
                Tasks.await(messaging.token, 30, TimeUnit.SECONDS)
            }.get(70, TimeUnit.SECONDS)
        }.getOrNull()
        return token?.takeIf { it.isNotEmpty() } ?: throw PushNotifications.Refused("This phone couldn’t sign up for notifications. Try again later.")
    }

    /* Notifications off here, or the account gone: no token is kept or renewed. Queued behind any token step; best effort. */
    fun stop(context: Context) {
        app(context) ?: return
        steps.execute {
            runCatching {
                val messaging = FirebaseMessaging.getInstance()
                messaging.isAutoInitEnabled = false
                Tasks.await(messaging.deleteToken(), 30, TimeUnit.SECONDS)
            }
        }
    }

    /*
     * At every signed-in start, for an account that turned notifications on here: the token again (Google may have
     * replaced it), sent on, and the kept handle given to the server again, as the web renews its subscription. A
     * server that turned them off or names no relay leaves it as it is. Blocking.
     */
    fun refresh(context: Context) {
        val session = Shared.session(context) ?: return
        if (!configured || PushNotifications.registration(context)?.belongsTo(session) != true || !allowed(context)) return
        // A server naming no relay now, or another one, has the registration let go of here (serverState).
        val relay = PushNotifications.serverState(context)?.relay ?: return
        PushNotifications.register(context, token(context), relay)
    }

    /*
     * Signed in and on screen: what the server holds that no push showed, posted in the same words, one per event (the
     * notification's id is the event's, so finding it again replaces it). One at a time. Blocking.
     */
    @Synchronized
    fun catchUp(context: Context) {
        if (!configured || !allowed(context)) return
        PushNotifications.catchUp(context).forEach { (id, notice) -> PushNotices.post(context, notice, id) }
    }

    /* Whether Android lets HushOS post notifications now. */
    fun allowed(context: Context): Boolean {
        if (!androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return android.os.Build.VERSION.SDK_INT < 33 ||
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }
}

/*
 * FCM's messages: a high-priority data message from the relay (id and tag, no notification block). Every one is
 * shown, the event's words or the fallback, so a server waking the phone is always seen (docs/devices-design.md 5).
 * The fetch runs under a deadline well inside the time FCM gives a high-priority message.
 */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val context = applicationContext
        val data = HashMap(message.data)
        val notice = AtomicReference<PushNotice?>(null)
        val work = Thread({ notice.set(PushNotifications.notice(context, data)) }, "HushOSPush")
        work.start()
        work.join(DEADLINE_MS)
        PushNotices.post(context, notice.get() ?: pushNoticeFallback(), data["id"]?.takeIf(PushNotifications::isEventId))
    }

    /* A new token for an account that turned notifications on here: registered again at once. */
    override fun onNewToken(token: String) {
        val context = applicationContext
        val session = Shared.session(context) ?: return
        if (PushNotifications.registration(context)?.belongsTo(session) != true) return
        Thread({
            runCatching {
                val relay = PushNotifications.serverState(context)?.relay ?: return@runCatching
                PushNotifications.register(context, token, relay)
            }
        }, "HushOSPushToken").start()
    }

    companion object {
        private const val DEADLINE_MS = 9_000L
    }
}
