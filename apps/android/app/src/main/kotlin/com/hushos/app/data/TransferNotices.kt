package com.hushos.app.data

import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.io.File
import java.net.URLDecoder
import java.net.URLEncoder

/*
 * One notification when transfers end while HushOS is out of sight, as on iOS: once the
 * queue has nothing left running (not once per file), on its own channel apart from the
 * ongoing progress notification, never while the app is on screen (the transfers sheet
 * says it there). Tapping it opens the transfers sheet; a failure that Retry can help
 * carries a Retry action. Names stay off the lock screen: its public version says only
 * that transfers finished or didn't.
 */
object TransferNotices {
    private const val CHANNEL = "transfer-results"
    private const val FILE = "transfer-outcomes.tsv"
    const val RETRY = "com.hushos.app.RETRY_TRANSFERS"
    /* A finished summary's tap: the folder the uploads went to ("…:<id>"), On this phone, or Files. */
    const val OPEN_FOLDER = "com.hushos.app.OPEN_FOLDER"
    const val OPEN_PHONE = "com.hushos.app.OPEN_PHONE"
    const val OPEN_FILES = "com.hushos.app.OPEN_FILES"

    /*
     * How a transfer ended; `reason` is null when it finished. A kept folder is one outcome, as it
     * is one row. `folder`: where an upload landed, so a tap can open it.
     */
    data class Outcome(val id: String, val name: String, val upload: Boolean, val reason: String? = null, val folder: String? = null)

    /*
     * The words. Finished: "3 files uploaded" naming them, or "“Lisbon” is on this phone";
     * didn't: "1 upload didn’t finish" with the file and its reason. Mixed or several keeps
     * use the transfers bar's own words.
     */
    fun words(ended: List<Outcome>): Pair<String, String?> {
        val failed = ended.filter { it.reason != null }
        if (failed.size == 1) {
            val only = failed[0]
            return (if (only.upload) "1 upload didn’t finish" else "1 transfer didn’t finish") to "“${only.name}”: ${only.reason}"
        }
        if (failed.isNotEmpty())
            return "${failed.size} ${if (failed.all { it.upload }) "uploads" else "transfers"} didn’t finish" to names(failed)
        if (ended.all { it.upload }) return "${ended.size} ${if (ended.size == 1) "file" else "files"} uploaded" to names(ended)
        if (ended.size == 1) return "“${ended[0].name}” is on this phone" to null
        return "${ended.size} transfers finished" to names(ended)
    }

    /* “a”, “a” and “b”, or “a”, “b” and 3 more. */
    private fun names(list: List<Outcome>): String {
        val quoted = list.map { "“${it.name}”" }
        return when (quoted.size) {
            1 -> quoted[0]
            2 -> "${quoted[0]} and ${quoted[1]}"
            else -> "${quoted[0]}, ${quoted[1]} and ${quoted.size - 2} more"
        }
    }

    /*
     * Whether the app's own screen (the one with the transfers sheet) is showing. Save to
     * HushOS doesn't count: it closes as its uploads start, and they end out of sight.
     */
    @Volatile private var started = 0
    val onScreen get() = started > 0

    fun watch(application: Application) = application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            if (activity !is com.hushos.app.MainActivity) return
            started++
            if (started == 1) forgetPending(activity)
        }
        override fun onActivityStopped(activity: Activity) { if (activity is com.hushos.app.MainActivity) started = (started - 1).coerceAtLeast(0) }
        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    })

    /* Back on screen: the sheet says how things ended, so nothing gathered so far is posted. */
    private fun forgetPending(context: Context) = synchronized(this) { File(context.filesDir, FILE).delete() }

    /*
     * A job ended (finished, or failed for good). Off screen it is gathered; once no other
     * job is queued or running (one that has already reported counts as done, so two
     * ending together still post once), the summary goes out.
     */
    fun ended(context: Context, outcome: Outcome) {
        if (onScreen) { forgetPending(context); return }
        val pending = synchronized(this) {
            val gathered = read(context).filter { it.id != outcome.id } + outcome
            write(context, gathered)
            val reported = gathered.map { it.id }.toSet()
            val active = runCatching { WorkManager.getInstance(context).getWorkInfosByTag(TransferQueue.TAG).get() }.getOrDefault(emptyList())
                .any { !it.state.isFinished && it.id.toString() !in reported && it.state != WorkInfo.State.CANCELLED }
            if (active) return
            File(context.filesDir, FILE).delete()
            gathered
        }
        post(context, pending)
    }

    private fun post(context: Context, ended: List<Outcome>) {
        val manager = NotificationManagerCompat.from(context)
        if (ended.isEmpty() || !manager.areNotificationsEnabled()) return
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val system = context.getSystemService(NotificationManager::class.java)
        if (system.getNotificationChannel(CHANNEL) == null)
            system.createNotificationChannel(NotificationChannel(CHANNEL, "Finished transfers", NotificationManager.IMPORTANCE_DEFAULT))
        val (title, body) = words(ended)
        val failed = ended.any { it.reason != null }
        val id = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
        // A failure opens the transfers sheet, where its row waits with Retry. Finished rows leave
        // the sheet moments after the queue empties, so a finished summary opens where the files
        // are instead: the folder uploads went to, or On this phone.
        val folders = ended.map { it.folder }.distinct()
        val target = when {
            failed -> TransferQueue.OPEN_TRANSFERS
            ended.all { it.upload } && folders.size == 1 && folders[0] != null -> "$OPEN_FOLDER:${folders[0]}"
            ended.none { it.upload } -> OPEN_PHONE
            else -> OPEN_FILES
        }
        val open = PendingIntent.getActivity(
            context, id,
            Intent(context, com.hushos.app.MainActivity::class.java).setAction(target).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val hidden = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(if (failed) "Transfers didn’t finish" else "Transfers finished")
            .build()
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(if (failed) android.R.drawable.stat_notify_error else android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(body?.let { NotificationCompat.BigTextStyle().bigText(it) })
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden)
        // Retry where it can work: the failures still on the record whose reason a retry can fix.
        val retryable = FailedTransfers.of(context).all().filter { it.id in ended.map(Outcome::id) && canRetry(it) }.map { it.id }
        if (retryable.isNotEmpty()) {
            val retry = PendingIntent.getBroadcast(
                context, id,
                Intent(context, RetryReceiver::class.java).setAction(RETRY).putExtra("ids", retryable.toTypedArray()).putExtra("notification", id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(0, "Retry", retry)
        }
        runCatching { manager.notify(id, builder.build()) }
    }

    /* Not for a file that's gone, an account out of room, or a session that ended: Retry can't fix those. */
    fun canRetry(failed: FailedTransfer): Boolean =
        !failed.sourceGone() && !TransferQueue.isNoRoom(failed.reason) && !failed.reason.contains("Sign in", ignoreCase = true)

    /* Sign-out and account wipe: the gathered names, and any summary still showing them. */
    fun clear(context: Context) {
        forgetPending(context)
        runCatching {
            val system = context.getSystemService(NotificationManager::class.java)
            system.activeNotifications.filter { it.notification.channelId == CHANNEL }.forEach { system.cancel(it.id) }
        }
    }

    private fun read(context: Context): List<Outcome> = runCatching { File(context.filesDir, FILE).readLines() }.getOrDefault(emptyList()).mapNotNull { line ->
        runCatching {
            val f = line.split("\t").map { if (it == "-") null else URLDecoder.decode(it.removePrefix("="), "UTF-8") }
            Outcome(f[0]!!, f[1]!!, f[2] == "true", f[3], f.getOrNull(4))
        }.getOrNull()
    }

    private fun write(context: Context, list: List<Outcome>) = File(context.filesDir, FILE).writeText(list.joinToString("\n") { o ->
        listOf(o.id, o.name, o.upload.toString(), o.reason, o.folder).joinToString("\t") { if (it == null) "-" else "=" + URLEncoder.encode(it, "UTF-8") }
    })

    /* Account files: AccountStore wipes this with the rest. */
    const val OUTCOMES = FILE
}

/* The notification's Retry: sends the failures again from the app's own record, then clears the notification. */
class RetryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TransferNotices.RETRY) return
        val ids = intent.getStringArrayExtra("ids")?.toSet().orEmpty()
        val pending = goAsync()
        Thread {
            try {
                for (failed in FailedTransfers.of(context).all().filter { it.id in ids && TransferNotices.canRetry(it) }) TransferQueue.retry(context, failed)
                NotificationManagerCompat.from(context).cancel(intent.getIntExtra("notification", 0))
            } finally {
                pending.finish()
            }
        }.start()
    }
}
