package com.hushos.app.data

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * Uploads and keeps that outlive the app. Each is a WorkManager job that
 * waits for a network, runs in the background (as a data-sync foreground job
 * with a notification, so a large file is not cut off), survives the app being
 * closed and the phone restarting, and is retried with backoff when the network
 * drops. An upload's file is copied into the app's own storage first, so the
 * picker's grant expiring or the cache being cleared cannot lose it; it is
 * deleted once the upload lands or fails for good.
 *
 * A job that the app is killed in the middle of starts that file again from the
 * first part: continuing it would mean keeping the file's content key on disk.
 */
object TransferQueue {
    const val TAG = "transfer"
    const val UPLOAD = "upload"
    const val KEEP = "keep"
    private const val CHANNEL = "transfers"
    /* The notification's tap: MainActivity opens the transfers sheet. */
    const val OPEN_TRANSFERS = "com.hushos.app.OPEN_TRANSFERS"
    /* An upload refused because the account is out of room: Retry can't help; Make room can. */
    const val NO_ROOM = "Not enough room for this file."

    /* Whether a failure's words are the out-of-room refusal (the server's own sentence too). */
    fun isNoRoom(message: String?): Boolean =
        message != null && (message == NO_ROOM || message.contains("Not enough storage", ignoreCase = true) || message.contains("quota", ignoreCase = true))

    /*
     * A name short enough for a notification's line, cut in the middle so its start and its
     * extension both show: "Quarterly report for the…final draft.pdf".
     */
    fun shortName(name: String, max: Int = 32): String {
        if (name.length <= max) return name
        val dot = name.lastIndexOf('.').takeIf { it > 0 && name.length - it <= 8 } ?: name.length
        val tail = (name.length - dot) + minOf(6, dot)
        val head = max - 1 - tail
        return if (head < 4) name.take(max - 1) + "…" else name.take(head) + "…" + name.takeLast(tail)
    }

    /* A failure's reason in words that say what to do: the transfers sheet's and the notification's. */
    fun reasonWords(message: String?): String {
        val said = message.orEmpty()
        return when {
            said.contains("reach", ignoreCase = true) || said.contains("network", ignoreCase = true) -> "Couldn’t reach HushOS. Check your connection, then retry."
            said.contains("gone", ignoreCase = true) || said.contains("Pick it again") -> "The file isn’t there any more. Pick it again."
            said.contains("Sign in", ignoreCase = true) -> "Sign in again to finish this."
            said.contains("downloaded copy") -> "Couldn’t update the copy on this phone. Retry, or keep it again later."
            isNoRoom(said) -> NO_ROOM
            said.isEmpty() || said == "The transfer failed." -> "This kept failing. Retry, or remove it from the list."
            else -> said
        }
    }

    private fun constraints() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /* Queues `staged` (moved into the queue's own folder) for upload into `folderId`; returns the job's id. */
    fun upload(context: Context, staged: File, name: String, mime: String?, folderId: String, replacingId: String?): UUID {
        val id = UUID.randomUUID()
        val dir = File(context.filesDir, "queue/$id").also { it.mkdirs() }
        val file = File(dir, "content")
        if (!staged.renameTo(file)) { staged.copyTo(file, overwrite = true); staged.delete() }
        return enqueueUpload(context, id, file, name, mime, folderId, replacingId)
    }


    /*
     * Sends a failed transfer again from the app's own record: an upload from the copy it
     * staged (false when that copy is gone: pick the file again), a keep by its item. The
     * record goes once the new job is queued.
     */
    fun retry(context: Context, failed: FailedTransfer): Boolean {
        val records = FailedTransfers.of(context)
        when (failed.kind) {
            UPLOAD -> {
                if (failed.sourceGone() || failed.folder == null) return false
                enqueueUpload(context, UUID.randomUUID(), File(failed.file!!), failed.name, failed.mime, failed.folder, failed.replacing)
            }
            KEEP -> keep(context, failed.node ?: return false, failed.name, folder = failed.isFolder, again = true, shareRoot = failed.shareRoot)
            else -> return false
        }
        records.forget(failed.id)
        return true
    }

    /* Removed from the list: the record, and the copy an upload kept for its retry. */
    fun dismiss(context: Context, failed: FailedTransfer) {
        FailedTransfers.of(context).forget(failed.id)
        if (failed.kind == UPLOAD) discard(failed.file)
    }

    /* Removes the copy a failed upload kept for a retry. */
    fun discard(file: String?) {
        file?.let { File(it).parentFile?.deleteRecursively() }
    }

    /*
     * Copies no job refers to any more: WorkManager forgets finished jobs on its own
     * after a day, and a failed upload's copy would outlive it. Young folders are left
     * alone, since a copy lands before its job is queued.
     */
    fun sweep(context: Context, inUse: Set<String>) {
        val cutoff = System.currentTimeMillis() - 10 * 60 * 1000
        // A failed upload on the app's own record keeps its copy for Retry, however old its job.
        val recorded = FailedTransfers.of(context).all().mapNotNull { it.file?.let { path -> File(path).parent } }.toSet()
        File(context.filesDir, "queue").listFiles()?.forEach { dir ->
            if (dir.path !in inUse && dir.path !in recorded && dir.lastModified() < cutoff) dir.deleteRecursively()
        }
    }

    private fun enqueueUpload(context: Context, id: UUID, file: File, name: String, mime: String?, folderId: String, replacingId: String?): UUID {
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setId(id)
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to UPLOAD, "file" to file.path, "name" to name, "mime" to mime, "folder" to folderId, "replacing" to replacingId))
            // The panel reads these: a job's input is not visible once it is queued.
            .addTag(TAG).addTag("kind:$UPLOAD").addTag("name:$name").addTag("file:${file.path}")
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("upload-$id", ExistingWorkPolicy.KEEP, request)
        return id
    }

    /*
     * Queues a file or a folder to be kept on this phone; one job per item, so asking twice
     * does not fetch it twice. `again`: a kept folder changed, so it runs once more after any
     * run under way (which may have missed the change) rather than being dropped.
     */
    fun keep(context: Context, nodeId: String, name: String, folder: Boolean = false, again: Boolean = false, shareRoot: String? = null) {
        val request = OneTimeWorkRequestBuilder<KeepWorker>()
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to KEEP, "node" to nodeId, "name" to name, "folder" to folder, "share" to shareRoot))
            .addTag(TAG).addTag("kind:$KEEP").addTag("name:$name").addTag("node:$nodeId")
            .apply { if (folder) addTag("folder") }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("keep-$nodeId", if (again) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    /* Stops a queued or running transfer and drops an upload's copy. */
    fun cancel(context: Context, id: UUID, file: String?) {
        WorkManager.getInstance(context).cancelWorkById(id)
        file?.let { File(it).parentFile?.deleteRecursively() }
    }

    /*
     * The ongoing notification Android requires while a job runs: the up arrow for uploads,
     * the down arrow for keeping a file on this phone, and a tap that opens the transfers sheet.
     * No Cancel here: cancelling asks first, in the app.
     */
    internal fun foreground(context: Context, id: Int, title: String, fraction: Float, keeping: Boolean = false, detail: String? = null): ForegroundInfo {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW))
        val open = android.app.PendingIntent.getActivity(
            context, 0,
            android.content.Intent(context, com.hushos.app.MainActivity::class.java).setAction(OPEN_TRANSFERS).addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(if (keeping) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(detail ?: if (fraction > 0f) "${(fraction * 100).toInt()}%" else null)
            .setContentIntent(open)
            .setProgress(100, (fraction * 100).toInt(), fraction <= 0f)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
}

/* A vault for a job: the tree opened from the mirror, so a folder or file can be found without the app. */
private fun jobVault(context: Context): Vault? = Vault.fromShared(context)?.also { runCatching { it.buildCatalogue() } }

/*
 * What to do after a failure: try again later for anything the network caused, give up otherwise.
 * A failure carries `inputs` along, so the panel can queue the same work again.
 */
private fun CoroutineWorker.outcome(error: Exception, inputs: androidx.work.Data = androidx.work.Data.EMPTY): androidx.work.ListenableWorker.Result = when {
    Resumable.retryable(error) && error !is NotAuthenticated -> androidx.work.ListenableWorker.Result.retry()
    else -> failed(when {
        error is NotAuthenticated -> "Sign in again to finish this."
        error is ApiError && error.status == 402 -> TransferQueue.NO_ROOM
        else -> error.message ?: "The transfer failed."
    }, inputs)
}

/*
 * A job that failed for good: it goes on the app's own record (FailedTransfers), so its row
 * and its Retry outlive WorkManager pruning finished jobs after a day, and a reboot.
 */
private fun CoroutineWorker.failed(message: String, inputs: androidx.work.Data = inputData): androidx.work.ListenableWorker.Result {
    val kind = inputData.getString("kind") ?: TransferQueue.UPLOAD
    FailedTransfers.of(applicationContext).record(FailedTransfer(
        id = id.toString(), kind = kind, name = inputData.getString("name") ?: "File", reason = message, at = System.currentTimeMillis(),
        file = inputData.getString("file"), mime = inputData.getString("mime"), folder = inputData.getString("folder"), replacing = inputData.getString("replacing"),
        node = inputData.getString("node"), isFolder = kind == TransferQueue.KEEP && inputData.getBoolean("folder", false), shareRoot = inputData.getString("share"),
    ))
    TransferNotices.ended(applicationContext, TransferNotices.Outcome(id.toString(), inputData.getString("name") ?: "File", kind == TransferQueue.UPLOAD, TransferQueue.reasonWords(message), inputData.getString("folder")))
    return androidx.work.ListenableWorker.Result.failure(androidx.work.Data.Builder().putAll(inputs).putString("message", message).build())
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = inputData.getString("name") ?: "File"

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), "Uploading “${TransferQueue.shortName(name)}”", 0f)

    override suspend fun doWork(): Result {
        val file = File(inputData.getString("file") ?: return failed("The file isn’t there any more. Pick it again."))
        if (!file.exists()) return failed("The file isn’t there any more. Pick it again.")
        runCatching { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return outcome(NotAuthenticated(), inputData)
        return withContext(Dispatchers.IO) {
            try {
                val folder = inputData.getString("folder")!!
                if (vault.item(folder) == null) vault.resolve(folder)
                val replacing = inputData.getString("replacing")?.let { vault.resolve(it) }
                val mime = inputData.getString("mime")
                var shown = 0
                vault.upload(file, name, mime, folder, replacing, vault.makeThumbnail(file, mime)) { fraction ->
                    setProgressAsync(workDataOf("fraction" to fraction))
                    val percent = (fraction * 100).toInt()
                    if (percent - shown >= 5) {
                        shown = percent
                        runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, id.hashCode(), "Uploading “${TransferQueue.shortName(name)}”", fraction)) }
                    }
                }
                file.parentFile?.deleteRecursively()
                TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = folder))
                Result.success()
            } catch (error: Exception) {
                // A failure keeps the copy: the panel can retry from it, and removes it when the row goes.
                outcome(error, inputData)
            }
        }
    }
}

class KeepWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = inputData.getString("name") ?: "File"

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), "Keeping “${TransferQueue.shortName(name)}” on this phone", 0f, keeping = true)

    override suspend fun doWork(): Result {
        runCatching { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return failed("Sign in again to finish this.")
        return withContext(Dispatchers.IO) {
            try {
                val id = inputData.getString("node")!!
                val folder = inputData.getBoolean("folder", false)
                val shareRoot = inputData.getString("share")
                val item = try {
                    if (folder) vault.openKeptFolder(id, shareRoot) else vault.resolve(id)
                } catch (error: NotFound) {
                    // A kept folder deleted from the drive: its files leave the phone with it.
                    if (folder) { Offline.forgetFolder(applicationContext, id); return@withContext Result.success() }
                    throw error
                }
                if (item == null) {
                    // The share stopped: what was kept from it goes, and the app says so.
                    Offline.forgetFolder(applicationContext, id)
                    return@withContext Result.success(workDataOf("unshared" to name))
                }
                var shown = 0
                val report = { fraction: Float, done: Int, total: Int ->
                    setProgressAsync(workDataOf("fraction" to fraction, "done" to done, "total" to total))
                    val percent = (fraction * 100).toInt()
                    if (percent - shown >= 5) {
                        shown = percent
                        runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, this@KeepWorker.id.hashCode(), "Keeping “${TransferQueue.shortName(name)}” on this phone", fraction, keeping = true)) }
                    }
                }
                if (item.isFolder) vault.keepFolder(item, shareRoot, report) else vault.keepDownloaded(item) { report(it, 0, 1) }
                TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@KeepWorker.id.toString(), name, upload = false))
                Result.success()
            } catch (error: Exception) {
                outcome(error)
            }
        }
    }
}
