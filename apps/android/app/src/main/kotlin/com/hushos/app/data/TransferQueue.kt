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
    /* How often an upload that couldn't check the name it keeps is tried again before it is said to have failed. */
    const val TRUST_RETRIES = 5
    const val NO_ROOM = "Not enough room for this file."

    /* Whether a failure's words are the out-of-room refusal (the server's own sentence too). */
    fun isNoRoom(message: String?): Boolean =
        message != null && (message == NO_ROOM || message == Problems.ROOM || message.contains("Not enough storage", ignoreCase = true) || message.contains("quota", ignoreCase = true))

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

    /* A queued upload's family folder: its family and workspace (FamilyUploads opens the family in the job). */
    data class Family(val groupId: String, val workspaceId: String)

    /* Queues `staged` (moved into the queue's own folder) for upload into `folderId`; returns the job's id. */
    fun upload(context: Context, staged: File, name: String, mime: String?, folderId: String, replacingId: String?, family: Family? = null): UUID {
        val id = UUID.randomUUID()
        val dir = File(context.filesDir, "queue/$id").also { it.mkdirs() }
        val file = File(dir, "content")
        if (!staged.renameTo(file)) { staged.copyTo(file, overwrite = true); staged.delete() }
        return enqueueUpload(context, id, file, name, mime, folderId, replacingId, family)
    }

    /*
     * This account isn't in the family any more (a not-member removal, here or in a job): every upload queued into its
     * folders fails at once (iOS's endFamily), its reserved server upload aborted (`abort`), its staged copy deleted, and
     * its row says why; failed ones kept for a retry lose their copies too. Only `session`'s: its jobs (by their session
     * tag) and rows, and only while it is still the one signed in and `still` holds, asked before and after every step that
     * can block, so a removal still running when another account signs in never touches that account's uploads.
     */
    fun endFamily(context: Context, groupId: String, session: Shared.Session, except: UUID? = null, still: () -> Boolean = { true },
                  abort: (uploadId: String, workspaceId: String) -> Reservations.Abort) =
        endFamily(context, groupId, session, except, still, abort) { WorkManager.getInstance(context).cancelWorkById(it) }

    /* The session's tag on each upload it queues: a digest, as the family walks' (FamilyWalkWork.sessionKey). */
    internal fun sessionTag(session: Shared.Session) = "session:" + FamilyWalkWork.sessionKey(session)

    /* Whether `session` is still the one signed in on this phone. */
    private fun signedIn(context: Context, session: Shared.Session) =
        Shared.session(context)?.let { it.token == session.token && it.userId.equals(session.userId, ignoreCase = true) } == true

    /* A removal's cleanup whose session ended (or whose caller stopped): nothing more of it runs. */
    private class SessionMoved : Exception()

    /* As above; `cancel` ends a queued job in WorkManager (a test sees what is written by then). */
    internal fun endFamily(context: Context, groupId: String, session: Shared.Session, except: UUID?, still: () -> Boolean,
                           abort: (uploadId: String, workspaceId: String) -> Reservations.Abort, cancel: (UUID) -> Unit) {
        fun current() { if (!still() || !signedIn(context, session)) throw SessionMoved() }
        try {
            current()
            endFamilyOf(context, groupId, sessionTag(session), except, ::current, abort, cancel)
        } catch (_: SessionMoved) {
            // Another session's now (or the caller stopped): its jobs and rows are not this cleanup's to touch.
        }
    }

    private fun endFamilyOf(context: Context, groupId: String, tag: String, except: UUID?, current: () -> Unit,
                            abort: (uploadId: String, workspaceId: String) -> Reservations.Abort, cancel: (UUID) -> Unit) {
        val work = WorkManager.getInstance(context)
        val records = FailedTransfers.of(context)
        val queue = File(context.filesDir, "queue").canonicalFile
        fun drop(job: String, path: String?) {
            val dir = path?.let { File(it).parentFile?.canonicalFile }
            // Only a job's own folder in the queue, never anything else a tag might name.
            current()
            dropJob(context, job, dir?.takeIf { it.parentFile == queue }, abort)
            current()
        }
        // Only this session's jobs (its tag): another account's upload into the same family is never ended here.
        val infos = runCatching { work.getWorkInfosByTag("family:${groupId.lowercase()}").get() }.getOrDefault(emptyList()).filter { tag in it.tags }
        current()
        val ending = infos.filter { !it.state.isFinished && it.id != except }
        fun ledgerOf(info: androidx.work.WorkInfo) = info.tags.firstOrNull { it.startsWith("ledger:") }?.removePrefix("ledger:") ?: info.id.toString()
        try {
            // Each queued one's row first, so a cancellation the panel hears already has its reason.
            for (info in ending) {
                current()
                records.record(FailedTransfer(info.id.toString(), UPLOAD, JobNames.of(context).get(info.id.toString()) ?: "File", FamilyWords.NOT_IN_FAMILY,
                    System.currentTimeMillis(), family = groupId.lowercase(), ledger = ledgerOf(info)))
            }
            for (info in ending) {
                current()
                cancel(info.id)
                drop(ledgerOf(info), info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:"))
            }
            // Failed ones kept for a Retry (their jobs perhaps pruned already): their copies go, their rows say why.
            current()
            for (failed in records.all().filter { it.family.equals(groupId, ignoreCase = true) }) {
                drop(failed.ledgerKey, failed.file)
                records.record(failed.copy(file = null, reason = FamilyWords.NOT_IN_FAMILY))
            }
            KeyChangeWaits.of(context).forgetAll(infos.map { it.id.toString() })
        } finally {
            // Whoever ended it (the app's sync or a job), last: the panel reads the rows again, as written.
            FailedTransfers.changed()
        }
    }


    /*
     * Sends a failed transfer again from the app's own record: an upload from the copy it
     * staged (false when that copy is gone: pick the file again), a keep by its item. The
     * record goes once the new job is queued. An upload's new job keeps the failed one's ledger key (`ledger`, the first
     * job's id): it settles what that key reserved first, or ends as uploaded by its landed row, never sending the file
     * again. Nothing is moved, so a process dying anywhere in a Retry leaves nothing behind but the row to retry again.
     */
    fun retry(context: Context, failed: FailedTransfer): Boolean {
        val records = FailedTransfers.of(context)
        when (failed.kind) {
            UPLOAD -> if (!retryUpload(failed) { id, ledger ->
                    enqueueUpload(context, id, File(failed.file!!), failed.name, failed.mime, failed.folder!!, failed.replacing,
                        failed.family?.let { group -> failed.familyWorkspace?.let { Family(group, it) } }, ledger)
                }) return false
            KEEP -> keep(context, failed.node ?: return false, failed.name, folder = failed.isFolder, again = true, shareRoot = failed.shareRoot)
            else -> return false
        }
        records.forget(failed.id)
        return true
    }

    /* An upload's retry: a new job id, queued (`enqueue`) under the failed one's ledger key; false when its copy is gone. */
    internal fun retryUpload(failed: FailedTransfer, enqueue: (UUID, String) -> Unit): Boolean {
        if (failed.sourceGone() || failed.folder == null) return false
        enqueue(UUID.randomUUID(), failed.ledgerKey)
        return true
    }

    /* Removed from the list: the record, and the copy an upload kept for its retry. */
    fun dismiss(context: Context, failed: FailedTransfer) {
        FailedTransfers.of(context).forget(failed.id)
        if (failed.kind == UPLOAD) discard(context, failed.file)
    }

    /* Removes the copy a failed upload kept for a retry; a reservation it left stays on record (Reservations) until settled. */
    fun discard(context: Context, file: String?) {
        file?.let { File(it).parentFile?.deleteRecursively() }
    }

    /*
     * A queued upload's run, as UploadWorker runs it inside its stop. Reservations no upload here is running any more (a
     * dead process's, a dropped job's) are settled first; if that settled one of this job's own as completed (its answer
     * lost), the job ends as uploaded at once (Reservations.Landed), before its family, folder or file is looked at. Then
     * a family folder's upload, the family opened in this job's own vault first on every look (FamilyUploads), a key change
     * not reached yet waited out here, a look every half minute for half an hour from when the wait began (`waits`, kept
     * across runs), the row saying so (`waiting`); or the account's own. This job's own records are settled again before it
     * reserves (Vault.upload), or nothing new is reserved.
     */
    internal fun runUpload(context: Context, vault: Vault, job: String, file: File, name: String, mime: String?, folder: String, replacingId: String?,
                           family: Family?, waits: KeyChangeWaits, pause: (Long) -> Unit, waiting: () -> Unit, progress: (Float) -> Unit,
                           now: () -> Long = System::currentTimeMillis, waitKey: String = job): Opened {
        Reservations.settleAll(context) { uploadId, workspaceId -> vault.api.abortUpload(uploadId, workspaceId) }
        if (Reservations.landed(context, job)) throw Reservations.Landed()
        if (family != null) {
            // The wait is this job's own (`waitKey`, the worker's id, as the panel and the job's end read it), never its ledger key's:
            // a Retry starts its half hour afresh and its row says it is finishing a key change.
            return FamilyUploads.waitingOutKeyChanges(since = { waits.since(waitKey) }, mark = { waits.mark(waitKey, it) }, now = now, pause = pause, waiting = waiting) {
                FamilyUploads.upload(vault, family.groupId, family.workspaceId, file, name, mime, folder, replacingId, job, progress)
            }
        }
        if (vault.item(folder) == null) vault.resolve(folder)
        val replacing = replacingId?.let { vault.resolve(it) }
        return vault.upload(file, name, mime, folder, replacing, vault.makeThumbnail(file, mime), job = job, progress = progress)
    }

    /*
     * A job's end for good (a family's removal, the worker's own included): what it reserved is settled now where the
     * server answers, and stays on record (Reservations) where it doesn't; its folder, copy and all, goes.
     */
    internal fun dropJob(context: Context, job: String, dir: File?, abort: (uploadId: String, workspaceId: String) -> Reservations.Abort) {
        runCatching { Reservations.settleJob(context, job, abort) }
        // The job is over: an outcome kept for its rerun (a landed row) has nobody to tell.
        Reservations.forgetLanded(context, job)
        dir?.deleteRecursively()
    }

    /*
     * Copies no job refers to any more: WorkManager forgets finished jobs on its own
     * after a day, and a failed upload's copy would outlive it. Young folders are left
     * alone, since a copy lands before its job is queued.
     */
    fun sweep(context: Context, inUse: Set<String>) {
        LandedJobs.of(context).sweep()
        val cutoff = System.currentTimeMillis() - 10 * 60 * 1000
        // A failed upload on the app's own record keeps its copy for Retry, however old its job.
        val recorded = FailedTransfers.of(context).all().mapNotNull { it.file?.let { path -> File(path).parent } }.toSet()
        File(context.filesDir, "queue").listFiles()?.forEach { dir ->
            if (dir.path !in inUse && dir.path !in recorded && dir.lastModified() < cutoff) dir.deleteRecursively()
        }
    }

    private fun enqueueUpload(context: Context, id: UUID, file: File, name: String, mime: String?, folderId: String, replacingId: String?, family: Family? = null,
                              ledger: String = id.toString()): UUID {
        val request = uploadRequest(id, file, mime, folderId, replacingId, family, ledger, Shared.session(context)?.let(::sessionTag))
        JobNames.of(context).put(id.toString(), name)
        WorkManager.getInstance(context).enqueueUniqueWork("upload-$id", ExistingWorkPolicy.KEEP, request)
        return id
    }

    /* An upload's job as WorkManager keeps it: ids and paths only, never the file's name (JobNames holds that). */
    /* `ledger`: the key its reservations are kept under (Reservations), the job's own id unless a Retry carries the first job's. */
    internal fun uploadRequest(id: UUID, file: File, mime: String?, folderId: String, replacingId: String?, family: Family? = null, ledger: String = id.toString(),
                               session: String? = null) =
        OneTimeWorkRequestBuilder<UploadWorker>()
            .setId(id)
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to UPLOAD, "file" to file.path, "mime" to mime, "folder" to folderId, "replacing" to replacingId,
                "family" to family?.groupId?.lowercase(), "familyWorkspace" to family?.workspaceId?.lowercase(), "ledger" to ledger))
            // The panel reads these: a job's input is not visible once it is queued. The name is the app's (JobNames).
            .addTag(TAG).addTag("kind:$UPLOAD").addTag("file:${file.path}").addTag("ledger:$ledger")
            .apply { if (family != null) addTag("family:${family.groupId.lowercase()}") }
            // The session that queued it (TransferQueue.sessionTag): a removal's cleanup ends only its own session's jobs.
            .apply { if (session != null) addTag(session) }
            .build()

    /*
     * Queues a file or a folder to be kept on this phone; one job per item, so asking twice
     * does not fetch it twice. `again`: a kept folder changed, so it runs once more after any
     * run under way (which may have missed the change) rather than being dropped.
     */
    fun keep(context: Context, nodeId: String, name: String, folder: Boolean = false, again: Boolean = false, shareRoot: String? = null) {
        val request = keepRequest(nodeId, folder, shareRoot)
        // Kept by the app, never in WorkManager's database, which sign-out can't empty (JobNames).
        JobNames.of(context).put(request.id.toString(), name)
        WorkManager.getInstance(context).enqueueUniqueWork("keep-$nodeId", if (again) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    /* A keep's job as WorkManager keeps it: the item's id, never its name. */
    internal fun keepRequest(nodeId: String, folder: Boolean, shareRoot: String?) =
        OneTimeWorkRequestBuilder<KeepWorker>()
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to KEEP, "node" to nodeId, "folder" to folder, "share" to shareRoot))
            .addTag(TAG).addTag("kind:$KEEP").addTag("node:$nodeId")
            .apply { if (folder) addTag("folder") }
            .build()

    /* Stops a queued or running transfer and drops an upload's copy. */
    fun cancel(context: Context, id: UUID, file: String?) {
        WorkManager.getInstance(context).cancelWorkById(id)
        file?.let { File(it).parentFile?.deleteRecursively() }
    }

    /*
     * The ongoing notification Android requires while a job runs: the up arrow for uploads,
     * the down arrow for keeping a file on this phone, and a tap that opens the transfers sheet.
     * No Cancel here: cancelling asks first, in the app. It names no file (see ongoingText), and
     * nothing is bridged to a watch or another device.
     */
    /*
     * What the ongoing notification says, in every field: how many transfers of its kind are under way and how far
     * this one is, never a file's name (lock screens showing all content and notification listeners read it all).
     */
    fun ongoingText(keeping: Boolean, count: Int, fraction: Float): NoticeText {
        val n = count.coerceAtLeast(1)
        val title = if (keeping) "Keeping $n ${if (n == 1) "item" else "items"} on this phone" else "Uploading $n ${if (n == 1) "file" else "files"}"
        val text = if (fraction > 0f) "${(fraction * 100).toInt()}%" else "Starting"
        return NoticeText(title, text, null, title)
    }

    /* Transfers of one kind queued or running now, for the ongoing notification's count. */
    internal fun active(context: Context, kind: String): Int =
        runCatching { WorkManager.getInstance(context).getWorkInfosByTag("kind:$kind").get().count { !it.state.isFinished } }.getOrDefault(1)

    internal fun foreground(context: Context, id: Int, fraction: Float, keeping: Boolean = false): ForegroundInfo {
        val words = ongoingText(keeping, active(context, if (keeping) KEEP else UPLOAD), fraction)
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW))
        val open = android.app.PendingIntent.getActivity(
            context, 0,
            android.content.Intent(context, com.hushos.app.MainActivity::class.java).setAction(OPEN_TRANSFERS).addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val icon = if (keeping) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_upload
        val public = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(icon)
            .setContentTitle(words.publicTitle)
            .setProgress(100, (fraction * 100).toInt(), fraction <= 0f)
            .setLocalOnly(true)
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(icon)
            .setContentTitle(words.title)
            .setContentText(words.text)
            .setContentIntent(open)
            .setProgress(100, (fraction * 100).toInt(), fraction <= 0f)
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setLocalOnly(true)
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
    // Whom this person trusts didn't load, so a replaced file's name couldn't be checked: tried again a few times, then said.
    error is TrustUnavailable && runAttemptCount < TransferQueue.TRUST_RETRIES -> androidx.work.ListenableWorker.Result.retry()
    else -> failed(when {
        error is NotAuthenticated -> "Sign in again to finish this."
        error is ApiError && error.status == 402 -> TransferQueue.NO_ROOM
        // Words for the transfers sheet; the exception's own text goes to the log.
        else -> Problems.say(error.also { android.util.Log.w("HushOS", "transfer failed", it) }, "The transfer failed.")
    }, inputs)
}

/*
 * A job that failed for good: it goes on the app's own record (FailedTransfers), so its row
 * and its Retry outlive WorkManager pruning finished jobs after a day, and a reboot.
 */
/* The job's file or folder name: the app's record of it (JobNames), or an older version's input. */
internal fun CoroutineWorker.jobName(): String = JobNames.of(applicationContext).get(id.toString()) ?: inputData.getString("name") ?: "File"

private fun CoroutineWorker.failed(message: String, inputs: androidx.work.Data = inputData): androidx.work.ListenableWorker.Result {
    val kind = inputData.getString("kind") ?: TransferQueue.UPLOAD
    FailedTransfers.of(applicationContext).record(FailedTransfer(
        id = id.toString(), kind = kind, name = jobName(), reason = message, at = System.currentTimeMillis(),
        file = inputData.getString("file"), mime = inputData.getString("mime"), folder = inputData.getString("folder"), replacing = inputData.getString("replacing"),
        node = inputData.getString("node"), isFolder = kind == TransferQueue.KEEP && inputData.getBoolean("folder", false), shareRoot = inputData.getString("share"),
        family = inputData.getString("family"), familyWorkspace = inputData.getString("familyWorkspace"), ledger = inputData.getString("ledger"),
    ))
    KeyChangeWaits.of(applicationContext).forget(id.toString())
    TransferNotices.ended(applicationContext, TransferNotices.Outcome(id.toString(), jobName(), kind == TransferQueue.UPLOAD, TransferQueue.reasonWords(message), inputData.getString("folder")))
    return androidx.work.ListenableWorker.Result.failure(androidx.work.Data.Builder().putAll(inputs).putString("message", message).build())
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = jobName()

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), 0f)

    // One run per job id at a time: a rerun waits for a stopped run still inside the upload (JobLocks).
    override suspend fun doWork(): Result = JobLocks.run(id.toString()) { work() }

    private suspend fun work(): Result {
        // A rerun of a run that landed after its stop: already uploaded and said; its copy is gone, so nothing else is looked at.
        if (LandedJobs.of(applicationContext).take(id.toString())) return Result.success()
        // Whose reservations this job holds: its own id, or the first job's that a Retry carried.
        val ledger = inputData.getString("ledger") ?: id.toString()
        val file = File(inputData.getString("file") ?: return failed("The file isn’t there any more. Pick it again."))
        val folder = inputData.getString("folder")!!
        val waits = KeyChangeWaits.of(applicationContext)
        // An earlier run's completion landed though its answer was lost (Reservations' landed row): done, said, its copy
        // gone, the row used up last. Looked at first, and again before the job reserves (Vault.upload).
        fun landedEarlier(): Result {
            // The success kept first (LandedJobs), before anything is deleted: a stop anywhere after this ends a rerun as uploaded.
            LandedJobs.of(applicationContext).markOrLog(this@UploadWorker.id.toString())
            waits.forget(this@UploadWorker.id.toString())
            file.parentFile?.deleteRecursively()
            TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = folder))
            Reservations.forgetLanded(applicationContext, ledger)
            return Result.success()
        }
        // An unreadable ledger decides nothing: the job runs again later.
        if (runCatching { Reservations.landed(applicationContext, ledger) }.getOrElse { return Result.retry() }) return landedEarlier()
        if (!file.exists()) return failed("The file isn’t there any more. Pick it again.")
        // Refused from the background (Android denies it there): the job runs as an ordinary one. A stop goes on.
        attempt { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return outcome(NotAuthenticated(), inputData)
        val family = inputData.getString("family")
        val familyWorkspace = inputData.getString("familyWorkspace")
        return withContext(Dispatchers.IO) {
            val end = stoppable({ isStopped }) { checkStop ->
                val mime = inputData.getString("mime")
                var shown = 0
                val progress = { fraction: Float ->
                    // A stop (Cancel, or the network constraint lost) abandons the upload here; the vault aborts it.
                    checkStop()
                    setProgressAsync(workDataOf("fraction" to fraction))
                    val percent = (fraction * 100).toInt()
                    if (percent - shown >= 5) {
                        shown = percent
                        runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, id.hashCode(), fraction)) }
                    }
                }
                TransferQueue.runUpload(applicationContext, vault, ledger, file, name, mime, folder, inputData.getString("replacing"),
                    if (family != null && familyWorkspace != null) TransferQueue.Family(family, familyWorkspace) else null, waits,
                    pause = { ms -> var left = ms; while (left > 0) { checkStop(); Thread.sleep(minOf(left, 1_000L)); left -= 1_000L } },
                    waiting = { setProgressAsync(workDataOf("fraction" to 0f)) }, progress = progress, waitKey = this@UploadWorker.id.toString())
            }
            when (end) {
                is JobEnd.Done -> {
                    // Landed, so it's said, and marked first whether or not this run was stopped: a rerun WorkManager schedules
                    // after a stop (during the last step, or during what follows, when it ignores this result) does nothing:
                    // no duplicate, no same-name failure, never "pick it again" for a copy deleted here.
                    LandedJobs.of(applicationContext).markOrLog(this@UploadWorker.id.toString())
                    waits.forget(this@UploadWorker.id.toString())
                    file.parentFile?.deleteRecursively()
                    TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = folder))
                    // Its landed row (written at the completion) goes last: a death before here ends a rerun as uploaded.
                    Reservations.forgetLanded(applicationContext, ledger)
                    Result.success()
                }
                // Nothing said, nothing recorded: WorkManager drops a cancelled job and reschedules one whose constraint went.
                JobEnd.Stopped -> Result.retry()
                is JobEnd.Failed -> when {
                    // An earlier run's completion landed after all (its answer lost): done, said, its copy gone.
                    // Landed: an earlier run's completion whose answer was lost, or a step after this run's completion failed.
                    end.error is Reservations.Landed -> landedEarlier()
                    // Not in the family any more: this upload and every other queued into the family end, copies deleted.
                    family != null && FamilyUploads.removed(end.error) -> {
                        TransferQueue.endFamily(applicationContext, family, vault.api.session, except = this@UploadWorker.id, still = { !isStopped }) { uploadId, workspaceId ->
                            vault.api.abortUpload(uploadId, workspaceId)
                        }
                        // Its own end through the same path: what it reserved settled or kept on record, then its folder.
                        TransferQueue.dropJob(applicationContext, ledger, file.parentFile) { uploadId, workspaceId -> vault.api.abortUpload(uploadId, workspaceId) }
                        failed(FamilyWords.NOT_IN_FAMILY, androidx.work.Data.EMPTY)
                    }
                    // A failure keeps the copy: the panel can retry from it, and removes it when the row goes.
                    else -> outcome(end.error, inputData)
                }
            }
        }
    }
}

/*
 * When each queued family upload began waiting out a key change (iOS's Record.keyChangeSince), kept across runs and
 * process deaths: what its row says while it waits, and when the wait gives up.
 */
class KeyChangeWaits private constructor(private val prefs: android.content.SharedPreferences) {
    fun since(jobId: String): Long? = prefs.getLong(jobId, 0L).takeIf { it > 0L }
    fun mark(jobId: String, at: Long) = prefs.edit().putLong(jobId, at).apply()
    fun forget(jobId: String) = prefs.edit().remove(jobId).apply()
    fun forgetAll(jobIds: Collection<String>) = prefs.edit().apply { jobIds.forEach { remove(it) } }.apply()

    companion object {
        fun of(context: Context) = KeyChangeWaits(context.getSharedPreferences("key-change-waits", Context.MODE_PRIVATE))
    }
}

class KeepWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = jobName()

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), 0f, keeping = true)

    override suspend fun doWork(): Result = JobLocks.run(id.toString()) { work() }

    private suspend fun work(): Result {
        // A rerun of a run that kept the item after its stop: done already. The next keep queued behind it runs as usual.
        if (LandedJobs.of(applicationContext).take(id.toString())) return Result.success()
        // Refused from the background (Android denies it there): the job runs as an ordinary one. A stop goes on.
        attempt { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return failed("Sign in again to finish this.")
        return withContext(Dispatchers.IO) {
            // Done(null): kept, and said; Done(a result): ended another way (the folder or share went), said by that result.
            val end = stoppable({ isStopped }) { checkStop ->
                val id = inputData.getString("node")!!
                val folder = inputData.getBoolean("folder", false)
                val shareRoot = inputData.getString("share")
                val item = try {
                    if (folder) vault.openKeptFolder(id, shareRoot) else vault.resolve(id)
                } catch (error: NotFound) {
                    // A kept folder deleted from the drive: its files leave the phone with it.
                    if (folder) { Offline.forgetFolder(applicationContext, id); return@stoppable Result.success() }
                    throw error
                }
                if (item == null) {
                    // The share stopped: what was kept from it goes, and the app says so.
                    Offline.forgetFolder(applicationContext, id)
                    // Said by the panel, which names it from the app's record (JobNames), not this output.
                    return@stoppable Result.success(workDataOf("unshared" to true))
                }
                var shown = 0
                val report = { fraction: Float, done: Int, total: Int ->
                    checkStop()
                    setProgressAsync(workDataOf("fraction" to fraction, "done" to done, "total" to total))
                    val percent = (fraction * 100).toInt()
                    if (percent - shown >= 5) {
                        shown = percent
                        runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, this@KeepWorker.id.hashCode(), fraction, keeping = true)) }
                    }
                }
                if (item.isFolder) vault.keepFolder(item, shareRoot, report) else vault.keepDownloaded(item) { report(it, 0, 1) }
                null
            }
            when (end) {
                is JobEnd.Done -> {
                    // Kept all the same: said, and marked so a rerun does nothing (the chain behind it isn't cancelled).
                    if (end.stopped) LandedJobs.of(applicationContext).markOrLog(this@KeepWorker.id.toString())
                    end.value ?: run {
                        TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@KeepWorker.id.toString(), name, upload = false))
                        Result.success()
                    }
                }
                JobEnd.Stopped -> Result.retry()
                is JobEnd.Failed -> outcome(end.error)
            }
        }
    }
}

/*
 * Every text field a transfer notification sets: title, content text, big text, the public version's title, and the
 * action labels. Built from counts and kinds only, so a test can hold all of them to naming no file.
 */
data class NoticeText(
    val title: String, val text: String?, val bigText: String?, val publicTitle: String, val actions: List<String> = emptyList(), val publicText: String? = null,
) {
    val fields: List<String> get() = listOfNotNull(title, text, bigText, publicTitle, publicText) + actions
}
