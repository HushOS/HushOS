package com.hushos.app.data

import android.content.Context
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/*
 * Every server upload reservation this phone makes, in one ledger with one rule: a reservation has a durable record from
 * the moment `begin` returns until it is definitely settled (its completion succeeded; an abort answered as releasing it;
 * the server saying it completed; or, where the server only says this account can't see it, its expiry having passed,
 * after which the server's expiry sweep has released it). Nothing else removes a record: not a failure, a retry, a
 * key-change wait, a family's removal, a cancel, a sweep, a dismissed row or a process dying. A job never reserves a new
 * upload while an older record of the same job is unsettled. Records live beside the account's files, never in a job's
 * folder, so deleting a folder can't lose one. The one exception is the account leaving the phone (sign-out, deletion,
 * another account signing in): AccountStore wipes the ledger with the rest, since no later session here can settle them.
 *
 * A queued job's reservation that turns out to have completed (its completion's answer was lost, and an abort, any run's,
 * hears "already finished") becomes a landed row of that job in the same write: the job ends as uploaded, never sending
 * the file again, and the row goes when it has (`forgetLanded`).
 */
object Reservations {
    /* How the server answered an abort (DriveApi.abortUpload), as packages/drive/src/server.ts abortUpload decides it. */
    enum class Abort {
        /* Aborted now or before: released. */
        RELEASED,
        /* It completed (409 "already finished"): the room went to the file; nothing to release. */
        COMPLETED,
        /*
         * 404 "no longer exists" or 403: the server answers both before it looks at the upload when this account can't
         * reach the workspace any more (requireUploadAccess), so the upload may still be reserved. Settled only once the
         * record's expiry has passed.
         */
        GONE,
        /* Not settled: no answer, a 5xx, the session gone, or 409 "finishing" (completing: its bytes stay reserved). */
        PENDING,
    }

    data class Record(val uploadId: String, val workspaceId: String, val job: String, val expiresAt: Long, val landed: Boolean = false)

    const val FILE = "upload-reservations.tsv"
    const val NEXT = "$FILE.next"
    /* packages/drive/src/protocol.ts UPLOAD_TTL_HOURS: how long an open upload lives. */
    const val TTL_MS = 24 * 60 * 60 * 1000L
    /*
     * After an upload's expiry, how long until the server has surely released it: the expiry sweep runs hourly
     * (packages/jobs/src/worker.ts, '7 * * * *'), and resolves an upload stuck completing an hour after it began completing,
     * which is no later than its expiry (packages/db/src/drive.ts listExpiredUploads).
     */
    const val GRACE_MS = 2 * 60 * 60 * 1000L

    /* Moves the written ledger over the old one (tests refuse it). */
    @Volatile internal var rename: (File, File) -> Boolean = { from, to -> from.renameTo(to) }

    /* The clock records' expiries are read against; a test moves it. */
    @Volatile internal var now: () -> Long = System::currentTimeMillis

    private val lock = Any()
    /* Uploads under way in this process: a sweep never aborts one of them (its own upload settles it). */
    private val active: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /* Records the disk refused (a full disk): held here until a later write takes them, and never reserved over. */
    private val unwritten = ConcurrentHashMap<String, Record>()

    private fun file(context: Context) = File(context.filesDir, FILE)

    /*
     * Moved by every wipe (the account leaving the phone). A vault keeps the one it was made in (Vault.ledgerGeneration):
     * `reserved`, the one write that adds a record, refuses an older one, so an upload still on its way when the account
     * left writes nothing of it back. Every other write only rewrites what the ledger holds, empty by then.
     */
    @Volatile var generation = 0L
        private set

    /*
     * `body`, under the lock a wipe moves the generation in, only while no wipe happened since `generation`: a transfer
     * job's writes after a blocking call (its failed row, its notification, its marks) either land before the wipe, which
     * then deletes them, or not at all. Null when the account left meanwhile.
     */
    fun <T> whileAccount(generation: Long, body: () -> T): T? = synchronized(lock) { if (generation != this.generation) null else body() }

    /* The account leaves the phone (AccountStore.wipe): the ledger and what was held go, under the ledger's own lock. */
    fun wipe(filesDir: File) = synchronized(lock) {
        generation++
        unwritten.clear()
        File(filesDir, FILE).delete()
        File(filesDir, NEXT).delete()
        Unit
    }

    /* The ledger couldn't be read (a permission, an I/O failure): nothing is reserved or written over it; the job runs again later. */
    class LedgerUnreadable(cause: Throwable) : java.io.IOException("The upload ledger couldn't be read.", cause)

    /* Every record. Only a ledger that isn't there is empty: any other failure to read it throws LedgerUnreadable. */
    fun all(context: Context): List<Record> = synchronized(lock) {
        val target = file(context)
        val lines = try {
            if (!target.exists()) emptyList() else target.readLines()
        } catch (error: Exception) {
            throw LedgerUnreadable(error)
        }
        // Every line whole, or the ledger is unreadable (fail closed): never a record skipped silently.
        val stored = lines.map { line ->
            val fields = line.split("\t")
            val expires = fields.getOrNull(3)?.toLongOrNull()
            if (fields.size != 5 || fields[0].isBlank() || expires == null || fields[4] !in setOf("landed", "reserved"))
                throw LedgerUnreadable(java.io.IOException("A ledger line doesn't parse."))
            Record(fields[0], fields[1], fields[2], expires, fields[4] == "landed")
        }
        stored + unwritten.values.filter { held -> stored.none { it.uploadId == held.uploadId } }
    }

    /* Written beside and moved over: a crash mid-write never leaves half a ledger. Every held record goes with it. */
    private fun write(context: Context, records: List<Record>) {
        val target = file(context)
        if (records.isEmpty()) target.delete()
        else {
            target.parentFile?.mkdirs()
            val next = File(target.parentFile, NEXT)
            next.writeText(records.joinToString("") {
                "${it.uploadId}\t${it.workspaceId}\t${it.job}\t${it.expiresAt}\t${if (it.landed) "landed" else "reserved"}\n"
            })
            // Moved over whole or not at all: a refused move leaves the ledger as it was, and the write fails.
            if (!rename(next, target)) { next.delete(); throw java.io.IOException("The upload ledger wasn't replaced.") }
        }
        unwritten.clear()
    }

    /*
     * `begin` returned: the reservation is on record before anything else happens to it. `job` is "" outside a queued job.
     * `beganAt` is when begin was sent, by this phone's clock; `serverExpiresAt` what begin's answer said, if it did. The
     * later of the two expiries is kept, so a clock that differs from the server's never settles one early. Throws when the
     * disk refuses it: the record is then held in memory (never reserved over in this process) and not marked running.
     */
    fun reserved(context: Context, uploadId: String, workspaceId: String, job: String, beganAt: Long, serverExpiresAt: Long?,
                 generation: Long = this.generation) = synchronized(lock) {
        if (generation != this.generation) throw SessionEnded()
        val record = Record(uploadId, workspaceId, job, maxOf(beganAt + TTL_MS, serverExpiresAt ?: 0L))
        try {
            write(context, all(context).filter { it.uploadId != uploadId } + record)
        } catch (error: Exception) {
            unwritten[uploadId] = record
            throw error
        }
        active.add(uploadId)
    }

    /* Definitely settled (the only way a reservation's record goes). A write the disk refuses leaves it, to be asked again. */
    fun settled(context: Context, uploadId: String) = synchronized(lock) {
        // Unread, nothing is written: the record stays on disk (one held only here goes), to be asked again.
        val rest = runCatching { all(context).filter { it.uploadId != uploadId } }.getOrNull()
        unwritten.remove(uploadId)
        rest?.let { runCatching { write(context, it) } }
        Unit
    }

    /*
     * It completed (its completion answered, or an abort heard "already finished"): settled. A queued job's record becomes
     * that job's landed row in the same write, so nothing after it (a name signed again, a process dying) sends the file
     * again. False when the disk refused the write: the record stays, to be asked again (its abort then says completed).
     */
    fun completed(context: Context, uploadId: String): Boolean = synchronized(lock) {
        // After a wipe there's no record to turn into a landed row (the wipe took them all, under this lock): nothing is written.
        val record = try { all(context).firstOrNull { it.uploadId == uploadId } } catch (_: LedgerUnreadable) { return false }
        if (record == null || record.job.isEmpty()) { settled(context, uploadId); return true }
        unwritten.remove(uploadId)
        try { write(context, all(context).filter { it.uploadId != uploadId } + record.copy(landed = true)) } catch (_: Exception) { unwritten[uploadId] = record; return false }
        true
    }

    /* The upload that made it isn't running any more in this process (landed, failed, stopped): a later settle may take it. */
    fun idle(uploadId: String) { active.remove(uploadId) }

    /*
     * An abort's answer applied: whether the reservation is settled now. Released, and gone past its expiry, settle it;
     * completed settles it too, and a queued job's record becomes that job's landed row in the same write.
     */
    fun aborted(context: Context, uploadId: String, answer: Abort): Boolean = synchronized(lock) {
        // Unread, nothing is decided: the record stays where it is, asked again later.
        val record = try { all(context).firstOrNull { it.uploadId == uploadId } } catch (_: LedgerUnreadable) { return false }
        when (answer) {
            Abort.RELEASED -> { settled(context, uploadId); true }
            Abort.COMPLETED -> completed(context, uploadId)
            Abort.GONE -> if (record == null || now() >= record.expiresAt + GRACE_MS) { settled(context, uploadId); true } else false
            Abort.PENDING -> false
        }
    }

    /* What settling a job's earlier reservations found. */
    enum class Settle {
        /* Nothing of the job is reserved: it may reserve. */
        CLEAR,
        /* One stays unanswered (or completing, or gone before its expiry): nothing new is reserved; the job runs again later. */
        PENDING,
        /* One completed after all (its answer was lost): the job's file landed, and it is not sent again. */
        LANDED,
    }

    /* Settles what `job` left reserved (an earlier run, a process that died, an earlier look of a key-change wait). */
    fun settleJob(context: Context, job: String, abort: (uploadId: String, workspaceId: String) -> Abort): Settle {
        for (record in all(context).filter { it.job == job && !it.landed && it.uploadId !in active }) {
            aborted(context, record.uploadId, abort(record.uploadId, record.workspaceId))
        }
        val left = all(context).filter { it.job == job }
        return when {
            left.any { !it.landed } -> Settle.PENDING
            left.any { it.landed } -> Settle.LANDED
            else -> Settle.CLEAR
        }
    }

    /* Read before any `begin`, whatever the job: a ledger that can't be read reserves nothing (LedgerUnreadable). */
    fun requireReadable(context: Context) { all(context) }

    /* Whether `job` has a landed row: an earlier run's completion landed though its answer was lost. */
    fun landed(context: Context, job: String): Boolean = job.isNotEmpty() && all(context).any { it.job == job && it.landed }

    /* The job ended (as uploaded, or for good): its landed rows go. Never a reservation's record. */
    fun forgetLanded(context: Context, job: String) = forgetLandedWhere(context) { it == job }

    /* Every landed row whose job `matches` goes (a write-back slot's, superseded saves' included, once the slot is empty). */
    fun forgetLandedWhere(context: Context, matches: (String) -> Boolean) = synchronized(lock) {
        val records = runCatching { all(context) }.getOrNull() ?: return@synchronized
        if (records.none { it.landed && matches(it.job) }) return@synchronized
        runCatching { write(context, records.filterNot { it.landed && matches(it.job) }) }
        Unit
    }

    /*
     * A queued job's file landed: in an earlier run whose completion answer was lost, or in this one with a step after the
     * completion failing (`cause`: the name signed again refused, a key change, a check). Done, never sent again; the
     * landed version's name re-sign is the deferred landed-version name repair (docs/groups-mobile-plan.md).
     */
    class Landed(cause: Throwable? = null) : Exception("Uploaded.", cause)

    /* Settles every record no upload in this process is still running (another job's leftovers, a dead process's). */
    fun settleAll(context: Context, abort: (uploadId: String, workspaceId: String) -> Abort) {
        for (record in all(context).filter { !it.landed && it.uploadId !in active }) {
            runCatching { aborted(context, record.uploadId, abort(record.uploadId, record.workspaceId)) }
        }
    }

    /* The account left the phone: records the disk never took go with the ledger file (AccountStore). */
    fun forgetHeld() = unwritten.clear()
}
