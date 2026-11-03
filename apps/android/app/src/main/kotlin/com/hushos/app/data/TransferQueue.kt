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
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
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

    /* Tests: runs once a slot's enqueue has looked for a waiting job, before it publishes anything. */
    @Volatile internal var beforeSlotEnqueued: (() -> Unit)? = null

    /*
     * A file's slot of saves another app made (WriteBacks) gets a job for the save just kept, unless one of its jobs is
     * still waiting to start: that one sends whatever the slot holds when it starts, this save included (it was kept
     * before this look). Never chained behind a running job, so no job's end, a failure included, ever takes a newer
     * save's job down with it: each save not yet sent has a job of its own, without the transfers panel. Jobs of one
     * slot run one at a time (JobLocks); one that finds the slot empty just ends. The job's id.
     */
    fun enqueueSlot(context: Context, slot: String, name: String, family: String? = null, accountGeneration: Long): UUID? {
        val work = WorkManager.getInstance(context)
        val waiting = runCatching { work.getWorkInfosByTag(WriteBacks.SLOT + slot).get() }.getOrNull()
            ?.firstOrNull { it.state == WorkInfo.State.ENQUEUED && sessionCurrent(context, it.tags) }
        beforeSlotEnqueued?.invoke()
        // For the account the save was made under (`accountGeneration`), checked again under the wipe's lock: a sign-out since
        // (another account's, or the lookup above blocking across it) took the slot, and nothing of it is published now: no
        // name, no job, no tag of the account signed in now.
        return Reservations.whileAccount(accountGeneration) {
            if (waiting != null) return@whileAccount waiting.id
            val session = Shared.session(context) ?: return@whileAccount null
            val id = UUID.randomUUID()
            val request = slotRequest(id, slot, WriteBacks.contentOf(context, slot), family, accountTag(session))
            JobNames.of(context).put(id.toString(), name)
            work.enqueue(request)
            id
        }
    }

    /*
     * A slot dropped for good (its family ended): every reservation its saves made settled (`slot#<save>`, superseded
     * saves' included), their landed rows used up, and its saves deleted. Whether one of them landed after all.
     */
    internal fun dropSlot(context: Context, slot: String, workId: String?, guarded: (() -> Unit) -> Unit,
                          abort: (uploadId: String, workspaceId: String) -> Reservations.Abort): Boolean {
        val landed = (workId != null && LandedJobs.of(context).has(workId)) || slotLanded(context, slot, abort)
        for (key in slotKeys(context, slot)) Reservations.forgetLanded(context, key)
        // Only while the account that began this is still the one here (`guarded`: under the wipe's lock): an abort can
        // block across a sign-out, and the next account's save of the same family file has the same slot.
        guarded { WriteBacks.drop(context, slot) }
        return landed
    }

    /*
     * Every reservation the slot's saves made settled (`slot#<save>`), and whether the file's save landed: the pending one's
     * own reservation, never an older save's (an older save landed while a newer one is still to send is no upload of
     * the newer). With nothing pending, whether any of its saves landed.
     */
    internal fun slotLanded(context: Context, slot: String, abort: (uploadId: String, workspaceId: String) -> Reservations.Abort): Boolean {
        val settled = slotKeys(context, slot).associateWith { key -> runCatching { Reservations.settleJob(context, key, abort) }.getOrNull() }
        val pending = WriteBacks.pending(context, slot) ?: return settled.values.any { it == Reservations.Settle.LANDED }
        return settled[pending.ledger] == Reservations.Settle.LANDED
    }

    /* The upload ledger's keys the slot's saves reserved under. */
    internal fun slotKeys(context: Context, slot: String): List<String> =
        runCatching { Reservations.all(context).map { it.job }.filter { WriteBacks.ledgerOf(slot, it) }.distinct() }.getOrDefault(emptyList())

    /* A slot's job as WorkManager keeps it: the slot and its contents' path (what the panel, Cancel and a failed row name). */
    internal fun slotRequest(id: UUID, slot: String, content: File, family: String? = null, session: String? = null) =
        OneTimeWorkRequestBuilder<UploadWorker>()
            .setId(id)
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to UPLOAD, "file" to content.path, "slot" to slot, "family" to family?.lowercase()))
            .addTag(TAG).addTag("kind:$UPLOAD").addTag("file:${content.path}").addTag(WriteBacks.SLOT + slot)
            .apply { if (family != null) addTag("family:${family.lowercase()}") }
            .apply { if (session != null) addTag(session) }
            .build()

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

    /*
     * The account's tag on each job it queues: a digest of its user id (no name, nothing the id can be read back from).
     * The account's, not the session's: the same account signing in again (its files kept, AccountStore.claim) finds its
     * jobs its own; another account never runs, ends or shows them.
     */
    internal fun accountTag(session: Shared.Session) = "account:" +
        java.security.MessageDigest.getInstance("SHA-256").digest(("hushos-account|" + session.userId.lowercase()).toByteArray())
            .take(12).joinToString("") { "%02x".format(it) }

    /* Whether the job tagged `tags` belongs to the account signed in now (an untagged one: whether anyone is). */
    internal fun sessionCurrent(context: Context, tags: Set<String>): Boolean {
        val now = Shared.session(context) ?: return false
        val tag = tags.firstOrNull { it.startsWith("account:") } ?: return true
        return tag == accountTag(now)
    }

    /*
     * Rows for jobs WorkManager failed that the app has no row of (the panel's watchQueue): only this account's, each written
     * under the wipe's lock while it is still the one here, and never one whose upload landed (its LandedJobs mark, left
     * when a removal ended it as uploaded), so a pruned-late FAILED entry never says "pick it again" for a file that's there.
     */
    internal fun recordUnrecordedFailures(context: Context, infos: List<WorkInfo>, hidden: Set<UUID>, generation: Long, nameOf: (WorkInfo) -> String) {
        val records = FailedTransfers.of(context)
        val landed = LandedJobs.of(context)
        for (info in infos) {
            if (info.state != WorkInfo.State.FAILED || info.id in hidden || !sessionCurrent(context, info.tags)) continue
            Reservations.whileAccount(generation) {
                if (sessionCurrent(context, info.tags) && !records.has(info.id.toString()) && !landed.has(info.id.toString()) && !obsolete(context, info))
                    records.record(FailedTransfer.fromWork(info, nameOf(info)))
            }
        }
    }

    /*
     * A failed slot job whose save is no longer the slot's pending one (it landed, a newer save replaced it, or it was
     * dismissed), or one that never ran: its row would only retry or show what is gone, or keep a save nobody tried from
     * its job, so WorkManager's entry never makes one.
     */
    private fun obsolete(context: Context, info: WorkInfo): Boolean {
        val slot = info.tags.firstOrNull { it.startsWith(WriteBacks.SLOT) }?.removePrefix(WriteBacks.SLOT) ?: return false
        // Failed without running (WorkManager failed it with the job it was queued behind, so its output says nothing): no
        // failure of its own, and no row, so the sweep gives its save a job of its own.
        if (info.outputData.getString("message") == null) return true
        val file = info.outputData.getString("file") ?: info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:")
        return WriteBacks.idOf(file) != WriteBacks.pending(context, slot)?.id
    }

    /* Tests: runs inside a cleanup's guarded write, right before it writes (a sign-out landing there). */
    @Volatile internal var beforeCleanupWrite: (() -> Unit)? = null

    /* Whether `session` is still the one signed in on this phone. */
    private fun signedIn(context: Context, session: Shared.Session) =
        Shared.session(context)?.let { it.token == session.token && it.userId.equals(session.userId, ignoreCase = true) } == true

    /* A removal's cleanup whose session ended (or whose caller stopped): nothing more of it runs. */
    private class SessionMoved : Exception()

    /* As above; `cancel` ends a queued job in WorkManager (a test sees what is written by then). */
    internal fun endFamily(context: Context, groupId: String, session: Shared.Session, except: UUID?, still: () -> Boolean,
                           abort: (uploadId: String, workspaceId: String) -> Reservations.Abort, cancel: (UUID) -> Unit) {
        // The account generation it started in: every write of a row is made under the lock a wipe moves it in, only while
        // nothing was wiped since and its session is still the one signed in, so it lands before a wipe or not at all.
        val generation = Reservations.generation
        fun current() { if (!still() || !signedIn(context, session)) throw SessionMoved() }
        fun write(body: () -> Unit) {
            Reservations.whileAccount(generation) {
                if (!still() || !signedIn(context, session)) null else { beforeCleanupWrite?.invoke(); body(); Unit }
            } ?: throw SessionMoved()
        }
        try {
            current()
            endFamilyOf(context, groupId, accountTag(session), except, ::current, ::write, abort, cancel)
        } catch (_: SessionMoved) {
            // Another session's now (or the caller stopped): its jobs and rows are not this cleanup's to touch.
        }
    }

    private fun endFamilyOf(context: Context, groupId: String, tag: String, except: UUID?, current: () -> Unit, write: (() -> Unit) -> Unit,
                            abort: (uploadId: String, workspaceId: String) -> Reservations.Abort, cancel: (UUID) -> Unit) {
        val work = WorkManager.getInstance(context)
        val records = FailedTransfers.of(context)
        val queue = File(context.filesDir, "queue").canonicalFile
        // Whether the job's upload landed (dropJob's answer); its folder goes either way.
        fun drop(job: String, path: String?, workId: String): Boolean {
            val dir = path?.let { File(it).parentFile?.canonicalFile }
            // Only a job's own folder in the queue, never anything else a tag might name.
            current()
            val landed = dropJob(context, job, dir?.takeIf { it.parentFile == queue }, workId, abort)
            current()
            return landed
        }
        // A job whose upload landed ends as uploaded: marked so (LandedJobs, which the panel's rebuild from a FAILED entry
        // respects), said as one, never a failure row.
        fun uploaded(workId: String) {
            LandedJobs.of(context).markOrLog(workId)
            TransferNotices.ended(context, TransferNotices.Outcome(workId, JobNames.of(context).get(workId) ?: "File", upload = true))
        }
        // Only this account's jobs (its tag): another account's upload into the same family is never ended here.
        val infos = runCatching { work.getWorkInfosByTag("family:${groupId.lowercase()}").get() }.getOrDefault(emptyList()).filter { tag in it.tags }
        current()
        val ending = infos.filter { !it.state.isFinished && it.id != except }
        fun ledgerOf(info: androidx.work.WorkInfo) = info.tags.firstOrNull { it.startsWith("ledger:") }?.removePrefix("ledger:") ?: info.id.toString()
        fun slotOf(info: androidx.work.WorkInfo) = info.tags.firstOrNull { it.startsWith(WriteBacks.SLOT) }?.removePrefix(WriteBacks.SLOT)
        // A slot's saves reserve under their own keys (`slot#<save>`): each is settled, so a reservation is released, or
        // found landed, whichever save of the slot made it.
        fun settledLanded(info: androidx.work.WorkInfo): Boolean = slotOf(info)?.let { slot -> slotLanded(context, slot, abort) }
            ?: (runCatching { Reservations.settleJob(context, ledgerOf(info), abort) }.getOrNull() == Reservations.Settle.LANDED)
        fun dropSlotHere(slot: String, workId: String): Boolean {
            current()
            val landed = dropSlot(context, slot, workId, write, abort)
            current()
            return landed
        }
        try {
            for (info in ending) {
                val workId = info.id.toString()
                // Settled first: its answer says whether the upload landed (a landed row, "already finished", a LandedJobs
                // mark). Then its row, before the job is cancelled, so a cancellation the panel hears has its reason.
                current()
                val landed = settledLanded(info) || LandedJobs.of(context).has(workId)
                write {
                    if (landed) uploaded(workId)
                    else records.record(FailedTransfer(workId, UPLOAD, JobNames.of(context).get(workId) ?: "File", FamilyWords.NOT_IN_FAMILY,
                        System.currentTimeMillis(), family = groupId.lowercase(), ledger = if (slotOf(info) != null) null else ledgerOf(info), slot = slotOf(info)))
                }
                current()
                cancel(info.id)
                // The second settle (dropJob's) may hear what the first didn't: a landing then ends it as uploaded after all,
                // its removal row replaced, before the landed row it read is gone.
                val slot = slotOf(info)
                val late = if (slot != null) dropSlotHere(slot, workId) else drop(ledgerOf(info), info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:"), workId)
                if (late && !landed) {
                    write { records.forget(workId); uploaded(workId) }
                }
            }
            // Failed ones kept for a Retry (their jobs perhaps pruned already): their copies go, their rows say why.
            current()
            // One whose upload landed after all (its answer lost, then the failure) ends as uploaded: its row goes.
            for (failed in records.all().filter { it.family.equals(groupId, ignoreCase = true) }) {
                val landed = if (failed.slot != null) dropSlotHere(failed.slot, failed.id) else drop(failed.ledgerKey, failed.file, failed.id)
                write {
                    if (landed) { records.forget(failed.id); uploaded(failed.id) }
                    else records.record(failed.copy(file = null, reason = FamilyWords.NOT_IN_FAMILY))
                }
            }
            // Saves of the family's files left with neither a job nor a row (a death between a save and its job): their
            // contents go too, never kept past the family.
            File(context.filesDir, "queue").listFiles()?.forEach { dir ->
                if (WriteBacks.pending(context, dir.name)?.target?.family.equals(groupId, ignoreCase = true)) dropSlotHere(dir.name, "")
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
        // The account it's pressed in: what it keeps and queues is that account's, or nothing (a sign-out since took the slot).
        val generation = Reservations.generation
        val records = FailedTransfers.of(context)
        when (failed.kind) {
            // A save that couldn't be kept in its slot: kept now (its edit as it was left), then sent. Not kept again: the row stays.
            UPLOAD -> if (failed.stage != null) {
                val target = failed.stage.let(WriteBacks::decodeTarget) ?: return false
                val edit = failed.file?.let(::File) ?: return false
                // Kept with the number its app closed it under: no newer than what the slot holds or landed, it is never kept
                // (Superseded) and its row and edit go, so an older save can't replace a newer one.
                val number = WriteBacks.stagedNumber(failed.stage) ?: return false
                var superseded = false
                fun stage(publishUnder: ((() -> WriteBacks.Pending?) -> WriteBacks.Pending?)? = null): WriteBacks.Pending? = try {
                    WriteBacks.stage(context, generation, target, edit, number, publishUnder)
                } catch (_: WriteBacks.Superseded) {
                    superseded = true
                    null
                } catch (_: Exception) {
                    null
                }
                val kept = if (target.familyWorkspace != null) {
                    // A family's edit: kept only while the folder hasn't been let go of since the row was made (its revocation
                    // count, as a family save checks it; a count lower than the row's is a later process's, where a revocation
                    // would have deleted the edit) and the edit is still there, checked under the copies lock a revocation's
                    // cleanup takes before the copy and again as it is published (the copy itself made outside that lock).
                    // Let go of: nothing is kept, the edit goes, and the row says why.
                    val session = Shared.session(context) ?: return false
                    val state = FamilySessions.of(session)
                    var revoked = false
                    fun letGo(): Boolean {
                        val now = state.epochs[target.familyWorkspace.lowercase()]?.first ?: 0L
                        revoked = state.closed || !edit.isFile || now > (WriteBacks.stagedEpoch(failed.stage) ?: 0L)
                        if (revoked) WriteBacks.discardEdit(edit)
                        return revoked
                    }
                    val saved = if (synchronized(FamilyCopies.LOCK) { letGo() }) null
                        else stage { publish -> synchronized(FamilyCopies.LOCK) { if (letGo()) null else publish() } }
                    if (revoked) {
                        Reservations.whileAccount(generation) { records.record(failed.copy(reason = FamilyWords.NOT_IN_FAMILY, stage = null)) }
                        FailedTransfers.changed()
                        return false
                    }
                    saved
                } else if (edit.isFile) stage() else null
                if (superseded) {
                    WriteBacks.discardEdit(edit)
                    Reservations.whileAccount(generation) { records.forget(failed.id) }
                    FailedTransfers.changed()
                    return false
                }
                kept ?: return false
                enqueueSlot(context, kept.slot, target.name, target.family, generation)
                WriteBacks.notifyFolder(context, target)
            // A file's slot: its job again, sending whatever the slot holds now (the newest save), never an older one.
            } else if (failed.slot != null) {
                if (WriteBacks.pending(context, failed.slot) == null) return false
                enqueueSlot(context, failed.slot, failed.name, failed.family, generation)
            } else if (!retryUpload(failed) { id, ledger ->
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
        // For the account it's pressed in, under the wipe's lock: after a sign-out nothing of it is written (a row list
        // rewritten after the wipe would bring the account's rows back).
        val generation = Reservations.generation
        Reservations.whileAccount(generation) { dismissHere(context, failed) }
    }

    private fun dismissHere(context: Context, failed: FailedTransfer) {
        // What the row holds goes first, the row last: a death between them leaves a row whose save is gone (dismissed
        // again, its Retry does nothing), never a save without its row that a start would queue or give a row again.
        // A save that was never kept in its slot: whatever of it reached the slot (a generation whose record wasn't
        // published), so no look recovers it, then its edit. A file's failed save: only that save goes (the slot with it
        // while it is still the pending one), never a newer one.
        if (failed.kind == UPLOAD && failed.stage != null) {
            val number = WriteBacks.stagedNumber(failed.stage)
            if (failed.slot != null && number != null) WriteBacks.dismissSave(context, failed.slot, number, failed.file?.let(::File))
            else failed.file?.let { WriteBacks.discardEdit(File(it)) }
            // Its listing no longer shows the dismissed save's size and date.
            WriteBacks.decodeTarget(failed.stage)?.let { WriteBacks.notifyFolder(context, it) }
        }
        else if (failed.kind == UPLOAD && failed.slot != null) WriteBacks.discard(context, failed.slot, failed.file)
        else if (failed.kind == UPLOAD) discard(context, failed.file)
        FailedTransfers.of(context).forget(failed.id)
    }

    /* Removes the copy a failed upload kept for a retry; a reservation it left stays on record (Reservations) until settled. */
    fun discard(context: Context, file: String?) {
        // Never a file's slot: those go only through WriteBacks, under their lock.
        file?.let { File(it).parentFile }?.takeIf { !WriteBacks.isSlot(it.name) }?.deleteRecursively()
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
        // A new version is found by its node, wherever it is now (another device may have moved it, its old folder gone).
        if (replacingId == null && vault.item(folder) == null) vault.resolve(folder)
        val replacing = replacingId?.let { vault.resolve(it) }
        return vault.upload(file, name, mime, folder, replacing, vault.makeThumbnail(file, mime), job = job, progress = progress)
    }

    /*
     * A job's end for good (a family's removal, the worker's own included): what it reserved is settled now where the
     * server answers, and stays on record (Reservations) where it doesn't; its folder, copy and all, goes. True when its
     * upload landed after all (settleJob's LANDED, or a LandedJobs mark for `workId`): the caller ends it as uploaded.
     */
    internal fun dropJob(context: Context, job: String, dir: File?, workId: String? = null,
                         abort: (uploadId: String, workspaceId: String) -> Reservations.Abort): Boolean {
        val landed = runCatching { Reservations.settleJob(context, job, abort) }.getOrNull() == Reservations.Settle.LANDED ||
            (workId != null && LandedJobs.of(context).has(workId))
        // The job is over: the landed row has told its caller, and nobody else is left to tell.
        Reservations.forgetLanded(context, job)
        // Never a file's slot: those go only through WriteBacks, under their lock (dropSlot).
        dir?.takeIf { !WriteBacks.isSlot(it.name) }?.deleteRecursively()
        return landed
    }

    /*
     * Copies no job refers to any more: WorkManager forgets finished jobs on its own
     * after a day, and a failed upload's copy would outlive it. Young folders are left
     * alone, since a copy lands before its job is queued.
     */
    /*
     * As the process starts (the app, a queued job, the Files app's provider): edits set right (reconcileEdits), then the
     * queue swept as the transfers panel sweeps it, so a save kept in its slot whose job was never queued (a death between
     * the two) is sent without the app being opened. Only while an account is signed in.
     */
    fun startupSweep(context: Context) {
        if (Shared.session(context) == null) return
        runCatching { reconcileEdits(context, startup = true) }
        runCatching { sweep(context, WorkManager.getInstance(context).getWorkInfosByTag(TAG).get()) }
    }

    fun sweep(context: Context, infos: List<WorkInfo>) {
        runCatching { reconcileEdits(context, startup = false) }
        val dirOf = { info: WorkInfo -> info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:")?.let { File(it).parent } }
        sweep(context, infos.mapNotNull(dirOf).toSet(), infos.map { it.id.toString() }.toSet(), infos.filter { !it.state.isFinished }.mapNotNull(dirOf).toSet())
    }

    /*
     * `inUse`: folders WorkManager still lists a job of (finished ones too), kept; `running`: those of unfinished jobs only,
     * the only ones that own a slot (a finished job sends nothing more, so a slot whose job finished before its save gets one).
     */
    fun sweep(context: Context, inUse: Set<String>, known: Set<String> = emptySet(), running: Set<String> = inUse) {
        // The account it looks for: a job it queues is that account's, or none (a sign-out since took the slots it read).
        val generation = Reservations.generation
        // A landed job's mark stays while WorkManager still lists the job: its FAILED entry is never read as a failure again.
        LandedJobs.of(context).sweep(keep = known)
        val cutoff = System.currentTimeMillis() - 10 * 60 * 1000
        // A failed upload on the app's own record keeps its copy for Retry, however old its job.
        val rows = FailedTransfers.of(context).all()
        val recorded = rows.mapNotNull { it.file?.let { path -> File(path).parent } }.toSet()
        File(context.filesDir, "queue").listFiles()?.forEach { dir ->
            // A file's pending save is kept until it lands, is cancelled or dismissed; one left without a job or a row (a
            // death between its save and its job) gets its job.
            // A row owns it only while the row's failed save is still the pending one (its Retry is the person's to press).
            if (WriteBacks.isSlot(dir.name)) {
                WriteBacks.pending(context, dir.name)?.let { pending ->
                    val failedHere = rows.any { it.slot == dir.name && WriteBacks.idOf(it.file) == pending.id }
                    if (dir.path !in running && !failedHere) enqueueSlot(context, dir.name, pending.target.name, pending.target.family, generation)
                    return@forEach
                }
                // An old slot with nothing to send and no job: gone, but only as one locked step that looks again first,
                // so a save published since the look above is never deleted.
                if (dir.path !in inUse && dir.lastModified() < cutoff) {
                    beforeSweepRemoves?.invoke(dir)
                    WriteBacks.removeIfEmpty(context, dir.name)
                }
                return@forEach
            }
            if (dir.path !in inUse && dir.path !in recorded && dir.lastModified() < cutoff) dir.deleteRecursively()
        }
    }

    private fun enqueueUpload(context: Context, id: UUID, file: File, name: String, mime: String?, folderId: String, replacingId: String?, family: Family? = null,
                              ledger: String = id.toString()): UUID {
        val request = uploadRequest(id, file, mime, folderId, replacingId, family, ledger, Shared.session(context)?.let(::accountTag))
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
            // The account that queued it (TransferQueue.accountTag): only that account runs it, ends it or shows it.
            .apply { if (session != null) addTag(session) }
            .build()

    /*
     * Queues a file or a folder to be kept on this phone; one job per item, so asking twice
     * does not fetch it twice. `again`: a kept folder changed, so it runs once more after any
     * run under way (which may have missed the change) rather than being dropped.
     */
    fun keep(context: Context, nodeId: String, name: String, folder: Boolean = false, again: Boolean = false, shareRoot: String? = null) {
        val request = keepRequest(nodeId, folder, shareRoot, Shared.session(context)?.let(::accountTag))
        // Kept by the app, never in WorkManager's database, which sign-out can't empty (JobNames).
        JobNames.of(context).put(request.id.toString(), name)
        WorkManager.getInstance(context).enqueueUniqueWork("keep-$nodeId", if (again) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    /* A keep's job as WorkManager keeps it: the item's id, never its name. */
    internal fun keepRequest(nodeId: String, folder: Boolean, shareRoot: String?, session: String? = null) =
        OneTimeWorkRequestBuilder<KeepWorker>()
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf("kind" to KEEP, "node" to nodeId, "folder" to folder, "share" to shareRoot))
            .addTag(TAG).addTag("kind:$KEEP").addTag("node:$nodeId")
            .apply { if (session != null) addTag(session) }
            .apply { if (folder) addTag("folder") }
            .build()

    /* Stops a queued or running transfer and drops an upload's copy. */
    fun cancel(context: Context, id: UUID, file: String?): java.util.concurrent.Future<*> {
        val dir = file?.let { File(it).parentFile }
        val queue = File(context.filesDir, "queue")
        if (dir == null || dir.parentFile != queue || !WriteBacks.isSlot(dir.name)) {
            WorkManager.getInstance(context).cancelWorkById(id)
            return cleanups.submit { dir?.deleteRecursively() }
        }
        // A file's slot: the save it holds as Cancel is pressed is what is cancelled (read now, without its lock); a save
        // made after that stays. Off the caller's thread (the panel's button), since the slot's lock may be held for a
        // whole file's copy: first those saves go, under the lock, then the job is cancelled (until then it is unfinished,
        // so no sweep queues the slot again), then a save left gets a job of its own (the cancelled one would have sent it).
        val slot = dir.name
        // The account it's pressed in: a job queued after it is that account's, or none (a sign-out since took the slot).
        val generation = Reservations.generation
        val cancelled = WriteBacks.publishedSave(context, slot)
        return cleanups.submit {
            WriteBacks.cancelThrough(context, slot, cancelled, generation)
            afterCancelCleans?.invoke()
            WorkManager.getInstance(context).cancelWorkById(id).result.get()
            // Read again once the cancel is done: a save made meanwhile may have found the cancelled job still waiting and
            // counted on it; it gets a job of its own.
            WriteBacks.pending(context, slot)?.let { enqueueSlot(context, slot, it.target.name, it.target.family, generation) }
        }
    }

    /*
     * Another app's save that couldn't be kept in its slot (WriteBacks.save threw: a full disk, say): its edit stays where it
     * is, the only copy of what the app believes it saved, and a row says so, whose Retry keeps it in the slot and sends it.
     * Only while the account it was made under is still here. Whether the row was made (else the edit can go).
     */
    fun stagingFailed(context: Context, target: WriteBacks.Target, edit: File, error: Exception, accountGeneration: Long, number: Long,
                      familyEpoch: Long? = null): Boolean = runCatching {
        // Never throws: a row that can't be written (the same full disk) leaves the closed edit for the next reconcile.
        Reservations.whileAccount(accountGeneration) {
            if (!edit.isFile) return@whileAccount false
            FailedTransfers.of(context).record(FailedTransfer(UUID.randomUUID().toString(), UPLOAD, target.name, Problems.say(error, "The transfer failed."),
                System.currentTimeMillis(), file = edit.path, mime = target.mime, folder = target.folder, replacing = target.nodeId,
                family = target.family, familyWorkspace = target.familyWorkspace, slot = WriteBacks.slotOf(target.workspaceId, target.nodeId),
                stage = WriteBacks.encodeTarget(target, familyEpoch, number)))
            FailedTransfers.changed()
            true
        } == true
    }.getOrDefault(false)

    /*
     * Edits on disk set right (as the process starts, and at every sweep of the queue): a closed edit no row names and whose
     * number the slot hasn't kept gets its staging row (one kept or superseded meanwhile goes); as the process starts, an
     * edit never closed, over a day old and no row naming it gets one too (its target beside it; it may be a save whose
     * close failed at every step), and only an edit without its target goes. Only for the account signed in.
     */
    fun reconcileEdits(context: Context, startup: Boolean) {
        val session = Shared.session(context) ?: return
        val generation = Reservations.generation
        // First every landing the ledger knows of that reads don't yet (a reservation settled as completed whose recording
        // was refused), then what a landing's bookkeeping left (rows a death kept), for the account it started in.
        if (startup) runCatching { WriteBacks.dropStaged(context) }
        Reservations.whileAccount(generation) {
            // Numbers that can't be read rebuilt first, so nothing old is published again from what they bounded.
            File(context.filesDir, WriteBacks.NUMBERS).listFiles()?.filter { !it.name.endsWith(".incoming") }?.forEach { runCatching { WriteBacks.repair(context, it.name) } }
            runCatching { Reservations.all(context) }.getOrDefault(emptyList()).filter { it.landed }.forEach { runCatching { WriteBacks.recoveredLanding(context, it.job) } }
            runCatching { FailedTransfers.of(context).all() }.getOrDefault(emptyList()).mapNotNull { it.slot }.toSet()
                .forEach { slot -> runCatching { retireLanded(context, slot) } }
        }
        // Then what a landing or a cancel that died after its bound left (staging rows and closed edits at or below it).
        val rows = runCatching { FailedTransfers.of(context).all() }.getOrElse { return }
        val edits = File(context.filesDir, WriteBacks.EDITS).walkTopDown().filter { it.isFile && it.name.endsWith(".closed") }.mapNotNull { closed ->
            runCatching { WriteBacks.decodeTarget(WriteBacks.sidecarOf(closed).readText()) }.getOrNull()?.let { WriteBacks.slotOf(it.workspaceId, it.nodeId) }
        }
        Reservations.whileAccount(generation) { (rows.filter { it.stage != null }.mapNotNull { it.slot } + edits).toSet().forEach { WriteBacks.retireSettled(context, it) } }
        val named = runCatching { FailedTransfers.of(context).all().mapNotNull { it.file }.toSet() }.getOrElse { return }
        val dayAgo = System.currentTimeMillis() - 86_400_000L
        File(context.filesDir, WriteBacks.EDITS).walkTopDown().filter { it.isFile }.toList().forEach { file ->
            when {
                file.name.endsWith(".closed") -> {
                    if (file.path in named) return@forEach
                    val number = WriteBacks.closedNumber(file) ?: return@forEach
                    val sidecar = runCatching { WriteBacks.sidecarOf(file).readText() }.getOrNull() ?: return@forEach
                    val target = WriteBacks.decodeTarget(sidecar) ?: return@forEach
                    // Made for another account (an open that outlived a sign-out): never this one's, and gone.
                    if (WriteBacks.accountOf(sidecar)?.let { !it.equals(session.userId, ignoreCase = true) } == true) { WriteBacks.discardEdit(file); return@forEach }
                    if (WriteBacks.keptAtOrAbove(context, WriteBacks.slotOf(target.workspaceId, target.nodeId), number)) { WriteBacks.discardEdit(file); return@forEach }
                    // A family's: made under the folder's revocation count it has now (a revocation would have deleted it).
                    val epoch = target.familyWorkspace?.let { ws ->
                        synchronized(FamilyCopies.LOCK) { if (!file.isFile) return@forEach; FamilySessions.of(session).epochs[ws.lowercase()]?.first ?: 0L }
                    }
                    stagingFailed(context, target, file, Exception("The save wasn't kept."), generation, number, epoch)
                }
                file.name.endsWith(".json") || file.name.endsWith(".incoming") -> {
                    val edit = File(file.parentFile, file.name.substringBefore('.'))
                    val closed = file.parentFile?.listFiles()?.any { it.name.startsWith(edit.name + ".") && it.name.endsWith(".closed") } == true
                    if (startup && !edit.exists() && !closed && file.lastModified() < dayAgo) file.delete()
                }
                // An edit never closed, over a day old and no row naming it: no process holds it any more, but its close may
                // have run with every step failing (the rename, the save, the row), so it may be a save. Never deleted here
                // while its target is beside it: it gets a staging row (numbered now, above the file's saves so far) to Retry
                // or Dismiss; an open abandoned partway shows up the same way. Only one without its target goes.
                else -> if (startup && file.path !in named && file.lastModified() < dayAgo) {
                    val sidecar = WriteBacks.sidecarOf(file)
                    val written = runCatching { sidecar.readText() }.getOrNull()
                    val target = written?.let(WriteBacks::decodeTarget)
                    if (target == null) { if (!sidecar.exists()) WriteBacks.discardEdit(file); return@forEach }
                    if (WriteBacks.accountOf(written)?.let { !it.equals(session.userId, ignoreCase = true) } == true) { WriteBacks.discardEdit(file); return@forEach }
                    val slot = WriteBacks.slotOf(target.workspaceId, target.nodeId)
                    val epoch = target.familyWorkspace?.let { ws ->
                        synchronized(FamilyCopies.LOCK) { if (!file.isFile) return@forEach; FamilySessions.of(session).epochs[ws.lowercase()]?.first ?: 0L }
                    }
                    stagingFailed(context, target, file, Exception("The save wasn't kept."), generation, WriteBacks.reserve(context, slot, generation) ?: return@forEach, epoch)
                }
            }
        }
    }

    /*
     * What a landing of `slot` made obsolete, gone: rows of failed saves numbered at or below its landed bound (a staging
     * row's edit too) and their failures still waiting to be summed up (a file that uploaded is never said not to have).
     * With `superseded` (the landing itself), every slot failure row but the still-pending save's (`keep`) too. Can be run
     * again and again: the landing's own job, its next run, and every reconcile run it, so a death mid-way leaves nothing.
     */
    internal fun retireLanded(context: Context, slot: String, keep: String? = null, superseded: Boolean = false) {
        val records = FailedTransfers.of(context)
        val through = WriteBacks.landedThrough(context, slot)
        val stale = records.all().filter { it.slot == slot }.filter { row ->
            if (row.stage != null) (WriteBacks.stagedNumber(row.stage) ?: Long.MAX_VALUE) <= through
            else (WriteBacks.numberOfId(WriteBacks.idOf(row.file)) ?: Long.MAX_VALUE) <= through || (superseded && WriteBacks.idOf(row.file) != keep)
        }
        if (stale.isEmpty()) return
        stale.filter { it.stage != null }.forEach { row -> row.file?.let { WriteBacks.discardEdit(File(it)) } }
        val obsolete = stale.map { it.id }.toSet()
        records.forgetWhere { it.id in obsolete }
        FailedTransfers.changed()
        TransferNotices.retire(context, obsolete)
    }

    /* Tests: runs after a cancel's saves went, before the job's cancel is published. */
    @Volatile internal var afterCancelCleans: (() -> Unit)? = null

    /* Tests: runs as the sweep is about to remove an old slot it found empty. */
    @Volatile internal var beforeSweepRemoves: ((File) -> Unit)? = null

    /* Tests: runs as a slot's job is about to end failed for good, after its last look at the slot. */
    @Volatile internal var beforeSlotFails: (() -> Unit)? = null

    /* Where a cancel's copies go: one thread, in the order the cancels came. */
    private val cleanups = java.util.concurrent.Executors.newSingleThreadExecutor()

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
/*
 * A job's writes after a blocking call (its failed row, its notification, its marks, its waits): only for the account it
 * ran for, still on the phone (no wipe since `generation`, its session tag the one signed in), under the wipe's own lock.
 * False, with nothing written, once that account left: nothing of it shows to the next.
 */
internal fun CoroutineWorker.forItsAccount(generation: Long, body: () -> Unit): Boolean =
    Reservations.whileAccount(generation) { if (TransferQueue.sessionCurrent(applicationContext, tags)) { body(); true } else false } == true

private fun CoroutineWorker.outcome(error: Exception, inputs: androidx.work.Data = androidx.work.Data.EMPTY, generation: Long): androidx.work.ListenableWorker.Result = when {
    Resumable.retryable(error) && error !is NotAuthenticated -> androidx.work.ListenableWorker.Result.retry()
    // Whom this person trusts didn't load, so a replaced file's name couldn't be checked: tried again a few times, then said.
    error is TrustUnavailable && runAttemptCount < TransferQueue.TRUST_RETRIES -> androidx.work.ListenableWorker.Result.retry()
    else -> failed(when {
        error is NotAuthenticated -> "Sign in again to finish this."
        error is ApiError && error.status == 402 -> TransferQueue.NO_ROOM
        // Words for the transfers sheet; the exception's own text goes to the log.
        else -> Problems.say(error.also { android.util.Log.w("HushOS", "transfer failed", it) }, "The transfer failed.")
    }, inputs, generation)
}

/*
 * A job that failed for good: it goes on the app's own record (FailedTransfers), so its row
 * and its Retry outlive WorkManager pruning finished jobs after a day, and a reboot.
 */
/* The job's file or folder name: the app's record of it (JobNames), or an older version's input. */
internal fun CoroutineWorker.jobName(): String = JobNames.of(applicationContext).get(id.toString()) ?: inputData.getString("name") ?: "File"

private fun CoroutineWorker.failed(message: String, inputs: androidx.work.Data = inputData, generation: Long): androidx.work.ListenableWorker.Result {
    val kind = inputData.getString("kind") ?: TransferQueue.UPLOAD
    // Its row and notification only for the account it ran for: one that left meanwhile gets neither.
    forItsAccount(generation) { recordFailure(kind, message, inputs.getString("file")) }
    return androidx.work.ListenableWorker.Result.failure(androidx.work.Data.Builder().putAll(inputs).putString("message", message).build())
}

private fun CoroutineWorker.recordFailure(kind: String, message: String, file: String? = null) {
    FailedTransfers.of(applicationContext).record(FailedTransfer(
        id = id.toString(), kind = kind, name = jobName(), reason = message, at = System.currentTimeMillis(),
        file = file ?: inputData.getString("file"), mime = inputData.getString("mime"), folder = inputData.getString("folder"), replacing = inputData.getString("replacing"),
        node = inputData.getString("node"), isFolder = kind == TransferQueue.KEEP && inputData.getBoolean("folder", false), shareRoot = inputData.getString("share"),
        family = inputData.getString("family"), familyWorkspace = inputData.getString("familyWorkspace"), ledger = inputData.getString("ledger"),
        slot = inputData.getString("slot"),
    ))
    KeyChangeWaits.of(applicationContext).forget(id.toString())
    TransferNotices.ended(applicationContext, TransferNotices.Outcome(id.toString(), jobName(), kind == TransferQueue.UPLOAD, TransferQueue.reasonWords(message), inputData.getString("folder")))
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val name get() = jobName()

    override suspend fun getForegroundInfo() = TransferQueue.foreground(applicationContext, id.hashCode(), 0f)

    // One run per job id at a time: a rerun waits for a stopped run still inside the upload (JobLocks).
    override suspend fun doWork(): Result = JobLocks.run(id.toString()) { work() }

    /*
     * A file's slot of saves another app made (WriteBacks), one run per slot at a time: whatever the slot holds is sent,
     * found by its workspace and node wherever it is now, and the slot cleared only while it still holds the generation
     * sent; a newer save that arrived meanwhile is sent next, until the slot is empty. Before every look, reservations a
     * dead run left are settled: a generation whose completion landed though its answer was lost is found landed and
     * never sent again, so nothing older can follow it. A failure keeps the slot (its row's Retry sends the newest), a
     * stop leaves it for the next run, and nothing is cleared or said once the account left (forItsAccount).
     */
    private suspend fun slotWork(slot: String, generation: Long): Result {
        val waits = KeyChangeWaits.of(applicationContext)
        var vault = jobVault(applicationContext) ?: return outcome(NotAuthenticated(), inputData, generation)
        val familyOf = inputData.getString("family")
        var first = true
        // Whether this run landed anything (and so said so).
        var sentHere = false
        // Not in the family any more: the family's uploads end, this slot with every reservation its saves made.
        fun removed(): Result {
            TransferQueue.endFamily(applicationContext, familyOf!!, vault.api.session, except = this@UploadWorker.id, still = { !isStopped }) { uploadId, workspaceId ->
                vault.api.abortUpload(uploadId, workspaceId)
            }
            if (!forItsAccount(generation) {}) return Result.failure()
            TransferQueue.dropSlot(applicationContext, slot, this@UploadWorker.id.toString(), { body -> forItsAccount(generation) { body() } }) { uploadId, workspaceId ->
                vault.api.abortUpload(uploadId, workspaceId)
            }
            return failed(FamilyWords.NOT_IN_FAMILY, androidx.work.Data.EMPTY, generation)
        }
        while (true) {
            val earlier = runCatching { TransferQueue.slotKeys(applicationContext, slot).isNotEmpty() }.getOrDefault(true)
            val settled = runCatching { Reservations.settleAll(applicationContext) { uploadId, workspaceId -> vault.api.abortUpload(uploadId, workspaceId) } }
            if (settled.isFailure) return Result.retry()
            // An earlier save of this file whose reservation is still unsettled (its abort unanswered, or still completing
            // after a lost connection, or gone with the family until its expiry) is waited for: no other save of it starts
            // while it could still land. A family file's removal is asked about first, so a removed family's saves end now.
            val unsettled = runCatching { Reservations.all(applicationContext).any { !it.landed && WriteBacks.ledgerOf(slot, it.job) } }
            if (unsettled.getOrDefault(true)) {
                val target = WriteBacks.pending(applicationContext, slot)?.target
                val workspace = target?.familyWorkspace
                if (familyOf != null && workspace != null &&
                    runCatching { FamilyUploads.open(vault, familyOf, workspace, target.folder) }.exceptionOrNull()?.let(FamilyUploads::removed) == true) return removed()
                return Result.retry()
            }
            // A save after the first in a run, or after an earlier save of the file was settled, goes out from a vault opened
            // afresh (its catalogue pulled again, after the settling): it replaces the version the server holds now, never
            // the one this vault held before an earlier save landed (its answer perhaps lost).
            if (!first || earlier) vault = jobVault(applicationContext) ?: return Result.retry()
            first = false
            // Its own copy to send (a full disk, say, can stop it): a failure of its own, with a row for the save kept, which
            // a Retry sends; the partial copy gone (WriteBacks.take).
            val taken = try {
                WriteBacks.take(applicationContext, slot, generation)
            } catch (error: Exception) {
                val kept = WriteBacks.pending(applicationContext, slot) ?: return Result.retry()
                return failed(Problems.say(error, "The transfer failed."), androidx.work.Data.Builder().putAll(inputData)
                    .putString("file", java.io.File(WriteBacks.dir(applicationContext, slot), kept.id + ".bin").path).build(), generation)
            }
            val (pending, sending) = taken ?: run {
                // Nothing (more) to send. A job that sent nothing still ends as one the summary waits for: what others
                // gathered goes out now if no other job is left (nothing of this one is said).
                // A landing whose bookkeeping a death cut short (or one recorded from a settled reservation) is finished here.
                forItsAccount(generation) { TransferQueue.retireLanded(applicationContext, slot) }
                if (!sentHere) forItsAccount(generation) { TransferNotices.settled(applicationContext, this@UploadWorker.id.toString()) }
                return Result.success()
            }
            val target = pending.target
            val ledger = pending.ledger
            // Landed: the slot cleared only while it still holds this save, said once, the landed row used up last (once the
            // slot is empty, every landed row of its saves: a superseded save's, found landed late, too).
            // Rows of the slot's failed saves go too, all but a still-pending save's (WorkManager's entries make none again:
            // obsolete). The landed bytes become the read copy of the version they became (this account's own drive; a
            // family's copies are its folder's to make), and a read serves those until it caught up (WriteBacks.landing).
            fun landed(version: String? = null): Boolean = forItsAccount(generation) {
                val readCopy = if (target.family == null && version != null) java.io.File(applicationContext.cacheDir, "files/${target.nodeId}/$version") else null
                val left = WriteBacks.landed(applicationContext, slot, pending.id, version, readCopy, pending.generation)
                // Obsolete: every failed save's row but the one still pending (superseded ones too, as the landing tells).
                TransferQueue.retireLanded(applicationContext, slot, left?.id, superseded = true)
                sentHere = true
                waits.forget(this@UploadWorker.id.toString())
                TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = target.folder))
                if (left == null) Reservations.forgetLandedWhere(applicationContext) { WriteBacks.ledgerOf(slot, it) } else Reservations.forgetLanded(applicationContext, ledger)
            }
            attempt { setForeground(getForegroundInfo()) }
            // The upload and what its end means (the landing's bookkeeping above all) in one block nothing cancels: WorkManager
            // stopping the job while a completion is in flight never throws away an upload that landed. The block's answer
            // is null to look at the slot again, else the job's result.
            val decided: Result? = withContext(NonCancellable) {
                val end = withContext(Dispatchers.IO) {
                    // Stopped by WorkManager, or by a cancel that took this save meanwhile (another job's): never landed then.
                    stoppable({ isStopped || WriteBacks.isCancelled(applicationContext, slot, pending.generation) }) { checkStop ->
                        var shown = 0
                        val progress = { fraction: Float ->
                            checkStop()
                            setProgressAsync(workDataOf("fraction" to fraction))
                            val percent = (fraction * 100).toInt()
                            if (percent - shown >= 5) {
                                shown = percent
                                runCatching { setForegroundAsync(TransferQueue.foreground(applicationContext, id.hashCode(), fraction)) }
                            }
                        }
                        TransferQueue.runUpload(applicationContext, vault, ledger, sending, target.name, target.mime, target.folder, target.nodeId,
                            if (target.family != null && target.familyWorkspace != null) TransferQueue.Family(target.family, target.familyWorkspace) else null, waits,
                            pause = { ms -> var left = ms; while (left > 0) { checkStop(); Thread.sleep(minOf(left, 1_000L)); left -= 1_000L } },
                            waiting = { setProgressAsync(workDataOf("fraction" to 0f)) }, progress = progress, waitKey = this@UploadWorker.id.toString())
                    }
                }
                // Its completion landed, whatever the end says (stopped by a cancel mid-completion, a step after it failing):
                // landed, its bookkeeping run, never discarded as stopped (its version unknown then: reads ask the server).
                val landedAnyway = end !is JobEnd.Done && runCatching { Reservations.landed(applicationContext, ledger) }.getOrDefault(false)
                // A landing keeps it (as the read copy) or deletes it with the slot (WriteBacks.landed).
                if (end !is JobEnd.Done && !landedAnyway && !(end is JobEnd.Failed && end.error is Reservations.Landed)) sending.delete()
                // A landing whose bookkeeping couldn't be written (its marker refused): the save stays pending, and the job's
                // next run finds it landed by its ledger and writes it again.
                fun settle(version: String? = null): Result? = try {
                    if (!landed(version)) Result.success() else null
                } catch (_: Exception) {
                    Result.retry()
                }
                if (landedAnyway) return@withContext settle()
                when (end) {
                    is JobEnd.Done -> settle(end.value.node.currentVersion?.id)
                    // Its save cancelled while it went up: nothing landed; whatever the slot holds now is next.
                    JobEnd.Stopped -> if (!isStopped && WriteBacks.isCancelled(applicationContext, slot, pending.generation)) null else Result.retry()
                    is JobEnd.Failed -> when {
                        // Its completion landed after all (its answer lost, or a step after it failed): landed.
                        end.error is Reservations.Landed -> settle()
                        // Not in the family any more: the family's uploads end, this slot with them.
                        familyOf != null && FamilyUploads.removed(end.error) -> removed()
                        // A newer save arrived meanwhile: this one's failure is moot (never sent now), and the newer gets its own try.
                        WriteBacks.pending(applicationContext, slot)?.id.let { it != null && it != pending.id } -> null
                        // A failure keeps the slot: its row (naming the failed save's own generation) Retries whatever it holds then.
                        else -> {
                            TransferQueue.beforeSlotFails?.invoke()
                            outcome(end.error, androidx.work.Data.Builder().putAll(inputData)
                                .putString("file", java.io.File(WriteBacks.dir(applicationContext, slot), pending.id + ".bin").path).build(), generation)
                        }
                    }
                }
            }
            if (decided != null) return decided
        }
    }

    private suspend fun work(): Result {
        // A rerun of a run that landed after its stop: already uploaded and said; its copy is gone, so nothing else is looked at.
        if (LandedJobs.of(applicationContext).take(id.toString())) return Result.success()
        // The account it runs for: the one signed in when it started (the generation every later write is checked against).
        // A job another account queued does nothing and writes nothing here; its output keeps what a Retry needs.
        val generation = Reservations.generation
        if (!TransferQueue.sessionCurrent(applicationContext, tags)) return Result.failure(inputData)
        inputData.getString("slot")?.let { slot -> return JobLocks.run(slot) { slotWork(slot, generation) } }
        // Whose reservations this job holds: its own id, or the first job's that a Retry carried.
        val ledger = inputData.getString("ledger") ?: id.toString()
        val file = File(inputData.getString("file") ?: return failed("The file isn’t there any more. Pick it again.", generation = generation))
        val folder = inputData.getString("folder")!!
        val waits = KeyChangeWaits.of(applicationContext)
        // An earlier run's completion landed though its answer was lost (Reservations' landed row): done, said, its copy
        // gone, the row used up last. Looked at first, and again before the job reserves (Vault.upload).
        fun landedEarlier(): Result {
            forItsAccount(generation) {
                // The success kept first (LandedJobs), before anything is deleted: a stop anywhere after this ends a rerun as uploaded.
                LandedJobs.of(applicationContext).markOrLog(this@UploadWorker.id.toString())
                waits.forget(this@UploadWorker.id.toString())
                file.parentFile?.deleteRecursively()
                TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = folder))
                Reservations.forgetLanded(applicationContext, ledger)
            }
            return Result.success()
        }
        // An unreadable ledger decides nothing: the job runs again later.
        if (runCatching { Reservations.landed(applicationContext, ledger) }.getOrElse { return Result.retry() }) return landedEarlier()
        if (!file.exists()) return failed("The file isn’t there any more. Pick it again.", generation = generation)
        // Refused from the background (Android denies it there): the job runs as an ordinary one. A stop goes on.
        attempt { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return outcome(NotAuthenticated(), inputData, generation)
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
                    // no duplicate, no same-name failure, never "pick it again" for a copy deleted here. Only for its account.
                    forItsAccount(generation) {
                        LandedJobs.of(applicationContext).markOrLog(this@UploadWorker.id.toString())
                        waits.forget(this@UploadWorker.id.toString())
                        file.parentFile?.deleteRecursively()
                        TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@UploadWorker.id.toString(), name, upload = true, folder = folder))
                        // Its landed row (written at the completion) goes last: a death before here ends a rerun as uploaded.
                        Reservations.forgetLanded(applicationContext, ledger)
                    }
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
                        // Its own end through the same path, only while its account is still the one here (asked again after
                        // each blocking step): what it reserved settled or kept on record, then its folder, then its row.
                        if (!forItsAccount(generation) {}) return@withContext Result.failure()
                        val landed = TransferQueue.dropJob(applicationContext, ledger, file.parentFile, this@UploadWorker.id.toString()) { uploadId, workspaceId ->
                            vault.api.abortUpload(uploadId, workspaceId)
                        }
                        // It landed after all (an earlier run's completion whose answer was lost): uploaded, not failed.
                        if (landed) landedEarlier() else failed(FamilyWords.NOT_IN_FAMILY, androidx.work.Data.EMPTY, generation)
                    }
                    // A failure keeps the copy: the panel can retry from it, and removes it when the row goes.
                    else -> outcome(end.error, inputData, generation)
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
        // As an upload's: the account it runs for, and nothing done or written for another account's job.
        val generation = Reservations.generation
        if (!TransferQueue.sessionCurrent(applicationContext, tags)) return Result.failure(inputData)
        // Refused from the background (Android denies it there): the job runs as an ordinary one. A stop goes on.
        attempt { setForeground(getForegroundInfo()) }
        val vault = jobVault(applicationContext) ?: return failed("Sign in again to finish this.", generation = generation)
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
                    if (end.stopped) forItsAccount(generation) { LandedJobs.of(applicationContext).markOrLog(this@KeepWorker.id.toString()) }
                    end.value ?: run {
                        forItsAccount(generation) { TransferNotices.ended(applicationContext, TransferNotices.Outcome(this@KeepWorker.id.toString(), name, upload = false)) }
                        Result.success()
                    }
                }
                JobEnd.Stopped -> Result.retry()
                is JobEnd.Failed -> outcome(end.error, generation = generation)
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
