package com.hushos.app.data

import android.content.Context
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/*
 * Every server upload reservation this phone makes, in one ledger with one rule: a reservation has a durable record from
 * the moment `begin` returns until it is definitely settled (its completion succeeded; an abort answered as releasing it;
 * the server saying it no longer exists, or that it completed). Nothing else removes a record: not a failure, a retry, a
 * key-change wait, a family's removal, a cancel, a sweep, a dismissed row or a process dying. A job never reserves a new
 * upload while an older record of the same job is unsettled. Records live beside the account's files, never in a job's
 * folder, so deleting a folder can't lose one. The one exception is the account leaving the phone (sign-out, deletion,
 * another account signing in): AccountStore wipes the ledger with the rest, since no later session here can settle them.
 */
object Reservations {
    /* How the server answered an abort (DriveApi.abortUpload), as packages/db/src/drive.ts abortUpload decides it. */
    enum class Abort {
        /* Aborted now or before, or the upload no longer exists (404): released. */
        RELEASED,
        /* It completed (409 "already finished"): the room went to the file; nothing to release. */
        COMPLETED,
        /* Not settled: no answer, a 5xx, the session gone, or 409 "finishing" (completing: its bytes stay reserved). */
        PENDING;

        val settled: Boolean get() = this != PENDING
    }

    data class Record(val uploadId: String, val workspaceId: String, val job: String)

    const val FILE = "upload-reservations.tsv"
    const val NEXT = "$FILE.next"
    private val lock = Any()
    /* Uploads under way in this process: a sweep never aborts one of them (its own upload settles it). */
    private val active: MutableSet<String> = ConcurrentHashMap.newKeySet()

    private fun file(context: Context) = File(context.filesDir, FILE)

    fun all(context: Context): List<Record> = synchronized(lock) {
        runCatching { file(context).readLines() }.getOrDefault(emptyList()).mapNotNull { line ->
            line.split("\t").takeIf { it.size == 3 && it[0].isNotBlank() }?.let { Record(it[0], it[1], it[2]) }
        }
    }

    private fun write(context: Context, records: List<Record>) {
        val target = file(context)
        if (records.isEmpty()) { target.delete(); return }
        target.parentFile?.mkdirs()
        // Written beside and moved over: a crash mid-write never leaves half a ledger.
        val next = File(target.parentFile, NEXT)
        next.writeText(records.joinToString("") { "${it.uploadId}\t${it.workspaceId}\t${it.job}\n" })
        if (!next.renameTo(target)) { target.writeText(next.readText()); next.delete() }
    }

    /* `begin` returned: the reservation is on record before anything else happens to it. `job` is "" outside a queued job. */
    fun reserved(context: Context, uploadId: String, workspaceId: String, job: String) = synchronized(lock) {
        active.add(uploadId)
        write(context, all(context).filter { it.uploadId != uploadId } + Record(uploadId, workspaceId, job))
    }

    /* Definitely settled (the only way a record goes). */
    fun settled(context: Context, uploadId: String) = synchronized(lock) {
        write(context, all(context).filter { it.uploadId != uploadId })
    }

    /* The upload that made it isn't running any more in this process (landed, failed, stopped): a later settle may take it. */
    fun idle(uploadId: String) { active.remove(uploadId) }

    /* An abort's answer applied: the record goes only when it settled the reservation. */
    fun aborted(context: Context, uploadId: String, answer: Abort): Abort {
        if (answer.settled) settled(context, uploadId)
        return answer
    }

    /* What settling a job's earlier reservations found. */
    enum class Settle {
        /* Nothing of the job is reserved: it may reserve. */
        CLEAR,
        /* One stays unanswered (or completing): nothing new is reserved; the job runs again later. */
        PENDING,
        /* One completed after all (its answer was lost): the job's file landed, and it is not sent again. */
        LANDED,
    }

    /* Settles what `job` left reserved (an earlier run, a process that died, an earlier look of a key-change wait). */
    fun settleJob(context: Context, job: String, abort: (uploadId: String, workspaceId: String) -> Abort): Settle {
        var landed = false
        for (record in all(context).filter { it.job == job && it.uploadId !in active }) {
            if (aborted(context, record.uploadId, abort(record.uploadId, record.workspaceId)) == Abort.COMPLETED) landed = true
        }
        return when {
            all(context).any { it.job == job } -> Settle.PENDING
            landed -> Settle.LANDED
            else -> Settle.CLEAR
        }
    }

    /* A queued job's file that landed in an earlier run whose completion answer was lost: done, not sent again. */
    class LandedEarlier : Exception("Uploaded.")

    /* Settles every record no upload in this process is still running (another job's leftovers, a dead process's). */
    fun settleAll(context: Context, abort: (uploadId: String, workspaceId: String) -> Abort) {
        for (record in all(context).filter { it.uploadId !in active }) {
            runCatching { aborted(context, record.uploadId, abort(record.uploadId, record.workspaceId)) }
        }
    }
}
