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

    private fun constraints() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /* Queues `staged` (moved into the queue's own folder) for upload into `folderId`; returns the job's id. */
    fun upload(context: Context, staged: File, name: String, mime: String?, folderId: String, replacingId: String?): UUID {
        val id = UUID.randomUUID()
        val dir = File(context.filesDir, "queue/$id").also { it.mkdirs() }
        val file = File(dir, "content")
        if (!staged.renameTo(file)) { staged.copyTo(file, overwrite = true); staged.delete() }
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

    /* Queues a file to be kept downloaded; one job per file, so asking twice does not fetch it twice. */
    fun keep(context: Context, nodeId: String, name: String) {
        val request = OneTimeWorkRequestBuilder<KeepWorker>()
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to KEEP, "node" to nodeId, "name" to name))
            .addTag(TAG).addTag("kind:$KEEP").addTag("name:$name")
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("keep-$nodeId", ExistingWorkPolicy.KEEP, request)
    }

    /* Stops a queued or running transfer and drops an upload's copy. */
    fun cancel(context: Context, id: UUID, file: String?) {
        WorkManager.getInstance(context).cancelWorkById(id)
        file?.let { File(it).parentFile?.deleteRecursively() }
    }

    internal fun foreground(context: Context, id: Int, title: String, fraction: Float): ForegroundInfo {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setProgress(100, (fraction * 100).toInt(), fraction <= 0f)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
}

/* A vault for a job: the tree opened from the mirror, so a folder or file can be found without the app. */
private fun jobVault(context: Context): Vault? = Vault.fromShared(context)?.also { runCatching { it.buildCatalogue() } }

/* What to do after a failure: try again later for anything the network caused, give up otherwise. */
private fun CoroutineWorker.outcome(error: Exception): androidx.work.ListenableWorker.Result = when {
    error is NotAuthenticated -> androidx.work.ListenableWorker.Result.failure(workDataOf("message" to "Sign in to HushOS again to finish this."))
    Resumable.retryable(error) -> androidx.work.ListenableWorker.Result.retry()
    else -> androidx.work.ListenableWorker.Result.failure(workDataOf("message" to (error.message ?: "The transfer failed.")))
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = inputData.getString("name") ?: "File"

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), "Uploading $name", 0f)

    override suspend fun doWork(): Result {
        val file = File(inputData.getString("file") ?: return Result.failure())
        if (!file.exists()) return Result.failure(workDataOf("message" to "The file to upload is gone."))
        runCatching { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return Result.failure(workDataOf("message" to "Sign in to HushOS to upload."))
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
                        runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, id.hashCode(), "Uploading $name", fraction)) }
                    }
                }
                file.parentFile?.deleteRecursively()
                Result.success()
            } catch (error: Exception) {
                val result = outcome(error)
                if (result is Result.Failure) file.parentFile?.deleteRecursively()
                result
            }
        }
    }
}

class KeepWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = inputData.getString("name") ?: "File"

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), "Keeping $name", 0f)

    override suspend fun doWork(): Result {
        runCatching { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return Result.failure(workDataOf("message" to "Sign in to HushOS to keep files."))
        return withContext(Dispatchers.IO) {
            try {
                val item = vault.resolve(inputData.getString("node")!!)
                vault.keepDownloaded(item) { fraction -> setProgressAsync(workDataOf("fraction" to fraction)) }
                Result.success()
            } catch (error: Exception) {
                outcome(error)
            }
        }
    }
}
