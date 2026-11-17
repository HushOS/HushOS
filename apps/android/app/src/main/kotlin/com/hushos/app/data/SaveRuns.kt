package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.PlannedResult
import com.hushos.core.runEstimate
import com.hushos.core.weakestCopyPrior
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicInteger

/*
 * The save path on the phone (docs/file-tools-design.md section 2, the web's packages/drive/src/save-runs.ts, iOS's
 * SaveRuns.swift): how File tools and editing write what they produce. Two modes: a new version of the same file, which a
 * version race ends `stale` (never a conflict copy), and a new file under the next free name in its folder, which never
 * replaces anything.
 *
 * A run asks its destination once whether it may be written and whether its results fit (padded ciphertext, by the core's
 * estimate, against the free space where that is the person's to know). Results upload from memory, never a temporary
 * plaintext file, and never resume. One row of ids per run (SaveRunRow) lets a cancel, a refusal, a 402, a failure or a
 * killed app leave no new file behind: open uploads aborted, what was published deleted forever, or moved to the Trash
 * where the person may not delete forever (an editor in someone else's share). A new version that already landed is kept,
 * never rolled back, and the run says so.
 *
 * Each result is signed by its own sources (the weakest of them, the core's weakestCopyPrior), or as the person's own
 * writing (SaveSources.OwnWriting), into family folders too, as on the web and iOS.
 */

/*
 * A run's row: ids only, never a name or a byte. `launch` is the process that ran it. `done`: the run finished (or its
 * results were kept, or cleaned up) but its row couldn't be removed: never offered, dropped next. `uncertain`: folders
 * whose creation was sent (written with the id, before it went) and not known answered, with when (epoch millis): one a
 * clean-up doesn't find may still be made, so the row stays until a later look finds it or CREATION_SETTLE_MS has passed.
 */
data class SaveRunRow(val id: String, val workspaceId: String, val nodeIds: List<String>, val uploadIds: List<String>, val at: Long, val launch: String,
                      val done: Boolean = false, val uncertain: Map<String, Long> = emptyMap(), val chosenDelete: Boolean = false,
                      val holds: Int? = null) {
    fun json(): JSONObject = JSONObject().put("id", id).put("workspaceId", workspaceId).put("nodeIds", JSONArray(nodeIds))
        .put("uploadIds", JSONArray(uploadIds)).put("at", at).put("launch", launch).also { if (done) it.put("done", true) }
        .also { if (uncertain.isNotEmpty()) it.put("uncertain", JSONObject(uncertain)) }
        .also { if (chosenDelete) it.put("chosen", "delete") }
        .also { holds?.let { count -> it.put("holds", count) } }

    companion object {
        fun from(json: JSONObject): SaveRunRow {
            fun list(name: String) = json.getJSONArray(name).let { array -> (0 until array.length()).map(array::getString) }
            val uncertain = json.optJSONObject("uncertain")?.let { held -> held.keys().asSequence().associateWith { held.getLong(it) } }.orEmpty()
            return SaveRunRow(json.getString("id"), json.getString("workspaceId"), list("nodeIds"), list("uploadIds"), json.getLong("at"), json.getString("launch"),
                json.optBoolean("done", false), uncertain, json.optString("chosen") == "delete",
                if (json.has("holds")) json.getInt("holds") else null)
        }
    }
}

/*
 * The rows, under filesDir: deleted with the account's files at sign-out (AccountStore.ACCOUNT_FILES), and a journal
 * opened before that writes nothing more (endAccount).
 */
class SaveRunJournal(val file: File, internal val epoch: Epoch = account) {
    /* Which account session journals belong to: moved on by every sign-out. */
    class Epoch {
        private val value = AtomicInteger()
        val current: Int get() = value.get()
        fun end() { value.incrementAndGet() }
    }

    private val born = epoch.current
    /* One lock per file, shared by every journal on it: two runs starting at once never lose each other's row. */
    private val lock: Any = locks.computeIfAbsent(file.absoluteFile.normalize().path) { Any() }
    /*
     * Where a write stages its rows before renaming them over the journal; one a failed write or a dead process left goes
     * at open, under the lock, so a journal opened while another writes never deletes that write's staging file.
     */
    private val staging = File(file.absoluteFile.parentFile, file.name + STAGING_SUFFIX).also { synchronized(lock) { it.delete() } }

    /* Whether this journal still belongs to the session it was opened in. */
    val live: Boolean get() = born == epoch.current

    /* Tests only: runs before each write with the rows it would write, and a throw refuses it as a full disk would. */
    @Volatile internal var fault: ((List<SaveRunRow>) -> Unit)? = null
    /* Renames the staging file over the journal in one atomic step (tests replace it to make it fail). */
    @Volatile internal var replace: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    /* Tests only: runs once a write's staging file is on disk, before it is renamed over the journal. */
    @Volatile internal var staged: (() -> Unit)? = null

    /* Tests only: runs (outside the lock) after each list's read, and before each swap takes the lock. */
    @Volatile internal var between: (() -> Unit)? = null

    /* Every row, those of finished runs (`done`) included. */
    fun list(): List<SaveRunRow> = synchronized(lock) { read() }.also { between?.invoke() }

    /*
     * Writes the row, once more if the first write is refused (rows are whole), and throws SaveUnrecorded when that one is
     * too: the run then stops, publishing nothing it doesn't name. After a sign-out it writes nothing and throws nothing.
     */
    fun put(row: SaveRunRow): Unit = synchronized(lock) {
        if (!live) return
        val rows = read().filter { it.id != row.id } + row
        try {
            write(rows)
        } catch (_: Exception) {
            try { write(rows) } catch (error: Exception) { throw SaveUnrecorded(error) }
        }
        // A sign-out ends the session under this same lock (endAccount): it can't come between the check and the write.
    }

    /*
     * A run's row goes: removed, asked again once; if the disk still refuses, marked `done` so no open offers what a
     * finished run made for deletion (and the next open drops it). False when neither was written: the row stays as it
     * was, and the caller says so rather than call it retired.
     */
    fun retire(row: SaveRunRow): Boolean = synchronized(lock) {
        if (!live) return true
        val others = read().filter { it.id != row.id }
        if (runCatching { write(others) }.isSuccess || runCatching { write(others) }.isSuccess) return true
        val done = others + row.copy(done = true)
        runCatching { write(done) }.isSuccess || runCatching { write(done) }.isSuccess
    }

    /*
     * The row as `expected` replaced by `next` (null removes it), only if it is still exactly that row: the compare and the
     * write under one hold of the file's lock, so no other write of this process lands in between (a Keep, another look).
     * False when it had changed, or the session ended.
     */
    fun swap(expected: SaveRunRow, next: SaveRunRow?): Boolean {
        between?.invoke()
        return swapLocked(expected, next)
    }

    private fun swapLocked(expected: SaveRunRow, next: SaveRunRow?): Boolean = synchronized(lock) {
        if (!live) return false
        val rows = read()
        if (rows.firstOrNull { it.id == expected.id } != expected) return false
        val others = rows.filter { it.id != expected.id }
        runCatching { write(if (next == null) others else others + next) }.isSuccess
    }

    /* Rows of finished runs that couldn't be removed then, removed now. */
    fun dropDone(): Unit = synchronized(lock) {
        if (!live) return
        val rows = read()
        if (rows.any { it.done }) runCatching { write(rows.filter { !it.done }) }
    }

    private fun read(): List<SaveRunRow> = runCatching {
        val array = JSONArray(file.readText())
        (0 until array.length()).map { SaveRunRow.from(array.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    /*
     * On disk before it returns, through a power loss too: the rows go to a file beside the journal, flushed (fsync),
     * renamed over it, and the folder flushed so the rename holds (the web's strict durability).
     */
    private fun write(rows: List<SaveRunRow>) {
        fault?.invoke(rows)
        val folder = file.absoluteFile.parentFile
        if (rows.isEmpty()) {
            if (file.exists() && !file.delete()) throw java.io.IOException("The save record couldn’t be removed.")
            flush(folder)
            return
        }
        folder?.mkdirs()
        try {
            java.io.FileOutputStream(staging).use { out ->
                out.write(JSONArray(rows.map { it.json() }).toString().toByteArray())
                out.fd.sync()
            }
            staged?.invoke()
            // One atomic replace: the journal is the old rows or the new ones, never neither. A replace that fails leaves the
            // old journal as it was.
            replace(staging, file)
        } catch (error: Exception) {
            // A write that failed leaves no staging file behind.
            staging.delete()
            throw error
        }
        flush(folder)
    }

    /* The folder's entry for the file on disk (a rename holds through a power loss); where a folder can't be opened, as it is. */
    private fun flush(folder: File?) {
        folder ?: return
        runCatching { java.nio.channels.FileChannel.open(folder.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) } }
    }

    companion object {
        const val FILE = "save-runs.json"
        private const val STAGING_SUFFIX = ".tmp"
        /* The staging file beside FILE: it goes with the account's files too (AccountStore.ACCOUNT_FILES). */
        const val STAGING = FILE + STAGING_SUFFIX
        val account = Epoch()
        private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()
        fun of(context: android.content.Context) = SaveRunJournal(File(context.filesDir, FILE))

        /*
         * Sign-out, deletion, removal: the session ends and the journal in `files` goes, both under the file's lock, so a
         * write already under way finishes before the delete, and one after it sees the session ended and writes nothing.
         */
        fun endAccount(files: File) = end(File(files, FILE), account)

        /* A session's end and its journal's removal under the file's lock (endAccount; the tests' own sessions too). */
        internal fun end(file: File, epoch: Epoch) {
            synchronized(locks.computeIfAbsent(file.absoluteFile.normalize().path) { Any() }) {
                epoch.end()
                file.delete()
                File(file.absoluteFile.parentFile, file.name + STAGING_SUFFIX).delete()
            }
        }
    }
}

/* A finished run (or kept results) whose record this device would not update: not retired, and asking again may. */
class SaveRecordNotUpdated : Exception("This was saved, but this device couldn’t update its record of it. Try again.")

/* finish() refused while a folder, file or version is still on its way (waiting()): ask again once it is in. The web's RunBusy. */
class RunBusy : Exception("Some results are still being saved.")

/* Work a run can't take (it finished, or a result it wasn't planned for): nothing was sent and nothing cleaned up. */
class SaveRunRefusal(message: String) : Exception(message)

/* This device would not keep a run's record (its storage full): the run stops rather than publish what no row names. */
class SaveUnrecorded(cause: Throwable) : Exception(SaveRuns.UNRECORDED, cause)

/*
 * What a result was made from. A folder counts with what was read from inside it (`within`), since a result made from a
 * folder carries its contents' marks as well as the folder's name record. `fromLink`: saved from a link, signed as saved.
 */
sealed class SaveSource {
    data class OfFile(val metadata: Integrity, val version: Integrity, val fromLink: Boolean = false) : SaveSource()
    data class OfFolder(val metadata: Integrity, val within: List<SaveSource>, val fromLink: Boolean = false) : SaveSource()

    companion object {
        /* A file's verdicts as Prior holds them (a save from a link as saved). */
        fun of(prior: Prior) = OfFile(prior.metadata, prior.version, prior.fromLink)
    }
}

/* A result's sources, or the person's own writing (ordinary statements). */
sealed class SaveSources {
    object OwnWriting : SaveSources()
    data class From(val sources: List<SaveSource>) : SaveSources()
}

/*
 * Whose space a destination is: the person's own Drive or their family's, with its free bytes as the server checks them
 * (null when not known), or someone else's share, whose owner's free space is never revealed.
 */
sealed class SaveRoom {
    data class Own(val free: Long?) : SaveRoom()
    data class Family(val free: Long?) : SaveRoom()
    object Shared : SaveRoom()
}

/* The server's answer for one item: in the Trash or deleted, not found, refused, or the space no longer this person's. */
/* HELD: a family manager paused this person's changes (403 `held`): refused until the hold lifts, nothing ended. */
enum class SaveItemFate { DONE, GONE, REFUSED, DENIED, HELD }

/*
 * The server's answer to an abort (`data.upload` naming a finishing and a finished upload, packages/drive/src/server.ts):
 * FINISHING is asked about again; UNKNOWN is no answer.
 */
enum class SaveAbortFate { ABORTED, GONE, FINISHED, FINISHING, DENIED, HELD, UNKNOWN }

/* What a run asks of the drive. The vault is one (VaultSaveWriter); tests stand one in. */
interface SaveRunWriter {
    /* Why `target` may not be written now, or null; a key change still walking it is no refusal (uploads wait it out). */
    fun refusal(target: Opened): String?
    fun room(workspaceId: String): SaveRoom
    fun names(folder: Opened): List<String>
    /* `minted` hears the folder's id before its creation is sent (the run records it first); a throw sends nothing. */
    fun makeFolder(folder: Opened, name: String, copy: Prior?, minted: (String) -> Unit): Opened
    fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                     thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit, onCompleting: (String) -> Unit): Opened
    /* `file` as the server lists its folder now (its keys after a key change), or null when it is no longer there. */
    fun fresh(file: Opened, folder: Opened): Opened?
    /*
     * How many items the folder `id` holds now, or null when it isn't there; throws when there was no answer. Only looks: an
     * answered "delete" waiting for a folder never deletes one found.
     */
    fun lookFolder(id: String, workspaceId: String): Int?
    /* `folder` and the chain above it as the server holds them now (a family's synced again first), to seal afresh under. */
    fun refreshFolder(folder: Opened): Opened
    /* Never FINISHING: an upload still completing is asked about again, then UNKNOWN (it may land yet). */
    fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate
    /* Each item's fate; throws only when the request as a whole got no answer. */
    fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate>
    fun purge(ids: List<String>, workspaceId: String): Map<String, SaveItemFate>
    /* Whether the server lets this person delete forever there: a member (their own Drive, a family's folder). */
    fun mayPurge(workspaceId: String): Boolean
}

/* What a clean-up did; LEFT when it couldn't finish (the row stays), NO_ACCESS when the space is no longer the person's (the row goes). */
enum class SaveCleanup { DELETED, TRASHED, NOTHING, LEFT, NO_ACCESS }

/* Why a run did not start: nothing was made. `needed` and `free` only in the person's own space, never a share. */
class SaveRefused(val reason: Reason, message: String, val needed: ULong? = null, val free: Long? = null) : Exception(message) {
    enum class Reason { READ_ONLY, NO_ROOM }
}

/*
 * Why a run stopped after it started, what its clean-up did, how many new versions had landed and were kept, and how many
 * may have (no answer to their abort, or still finishing: they may land yet).
 */
class SaveRunStopped(val reason: Reason, message: String, val cleanup: SaveCleanup, val keptVersions: Int = 0, val uncertainVersions: Int = 0) :
    Exception(message) {
    enum class Reason { CANCELLED, NO_ROOM, FAILED, SIGNED_OUT }
}

sealed class VersionSaved {
    data class Saved(val item: Opened) : VersionSaved()
    data class Stale(val currentVersionId: String?) : VersionSaved()
}

object SaveRuns {
    const val NO_ROOM = "There isn’t enough room for this. Nothing was saved."
    const val NO_ROOM_SHARED = "There isn’t enough room in this shared folder for this. Nothing was saved."
    const val CANCELLED = "Cancelled. Nothing was saved."
    const val FAILED = "This couldn’t be saved, so nothing was kept."
    const val UNRECORDED = "This device couldn’t keep a record of this save."

    /* This process: a row another launch left is interrupted, one of this launch's is a live run's. */
    val launch: String = UUID.randomUUID().toString()

    /* Runs live in this process, held weakly: a sign-out abandons them. */
    private val live = java.util.Collections.newSetFromMap(java.util.WeakHashMap<SaveRun, Boolean>())
    internal fun register(run: SaveRun) = synchronized(live) { live.add(run) }

    /*
     * A sign-out (AccountStore.wipe, beside SaveRunJournal.endAccount): every run stops at once, writing nothing more and
     * deleting nothing afterwards (the session that could is ending).
     */
    fun abandonAll(epoch: SaveRunJournal.Epoch = SaveRunJournal.account) {
        // The runs of one account session (their journals' epoch): a test's own session is never another's sign-out.
        val runs = synchronized(live) { live.filter { it.journalEpoch === epoch } }
        for (run in runs) run.abandon()
    }

    /* What a stopped run says: never "nothing was saved" once a new version landed, or while one may (the web's stoppedWords). */
    fun words(reason: SaveRunStopped.Reason, shared: Boolean, failure: String?, kept: Int, uncertain: Int = 0, remains: SaveCleanup? = null,
              held: Boolean = false): String {
        // New files or folders that may still be there: the row kept for the next launch (LEFT), or out of reach. A family
        // manager's pause kept the clean-up from them: said as such, the row kept.
        val left = if (held && remains == SaveCleanup.LEFT) " Changes are paused in this family, so what was made is still there. You’ll be asked about it next time."
        else when (remains) {
            SaveCleanup.LEFT -> " Some of what was made may still be there. You’ll be asked about it next time."
            SaveCleanup.NO_ACCESS -> " Some of what was made may still be there, and you can no longer remove it."
            // After a sign-out: what may stay with nothing more to ask.
            SaveCleanup.NOTHING -> " Some of what was made may still be there."
            else -> ""
        }
        val opening = when (reason) {
            SaveRunStopped.Reason.CANCELLED -> "Cancelled."
            SaveRunStopped.Reason.NO_ROOM -> if (shared) "There isn’t enough room in this shared folder for this." else "There isn’t enough room for this."
            SaveRunStopped.Reason.SIGNED_OUT -> "You signed out before this was saved."
            SaveRunStopped.Reason.FAILED -> sentence(failure ?: "This couldn’t be saved.")
        }
        if (kept == 0 && uncertain == 0 && left.isEmpty()) return if (reason == SaveRunStopped.Reason.FAILED && failure == null) FAILED else "$opening Nothing was saved."
        val versions = when (kept) {
            0 -> ""
            1 -> " The new version saved before that was kept."
            else -> " The $kept new versions saved before that were kept."
        }
        val maybe = when (uncertain) {
            0 -> ""
            1 -> " ${if (kept == 0) "A" else "Another"} new version may have been saved."
            else -> " $uncertain ${if (kept == 0) "" else "other "}new versions may have been saved."
        }
        return "$opening$versions$maybe${left.ifEmpty { " Nothing else was saved." }}"
    }

    /* A reason as a sentence: trimmed, and ended with a full stop when it has none. */
    internal fun sentence(text: String): String {
        val trimmed = text.trim()
        return if (trimmed.isEmpty() || trimmed.last() in ".!?…") trimmed else "$trimmed."
    }

    const val ALREADY_SAVED = "This was already saved, so it was kept."

    internal fun signedOut() = SaveRunStopped(SaveRunStopped.Reason.SIGNED_OUT, words(SaveRunStopped.Reason.SIGNED_OUT, false, null, 0), SaveCleanup.NOTHING)

    /*
     * What a result is signed as a copy of: record by record, the weakest of its sources' verdicts (the core's
     * weakestCopyPrior), a folder with everything read from inside it, a source saved from a link as saved; null (the
     * ordinary statements) for the person's own writing. A source nobody could check is re-sealed, never vouched for and never
     * a refusal, as on the web (copyMetadataSignature's refusal stays for plain copies, which try again once trust loads).
     */
    fun signing(sources: SaveSources): Prior? {
        if (sources !is SaveSources.From) return null
        fun checked(verdict: Integrity) = if (verdict == Integrity.UNCHECKED) Integrity.RESEALED else verdict
        val metadata = ArrayList<Integrity>()
        val version = ArrayList<Integrity>()
        fun visit(each: List<SaveSource>) {
            for (source in each) when (source) {
                is SaveSource.OfFile -> {
                    metadata += if (source.fromLink) Integrity.SAVED_FROM_LINK else checked(source.metadata)
                    version += if (source.fromLink) Integrity.SAVED_FROM_LINK else checked(source.version)
                }
                is SaveSource.OfFolder -> {
                    val verdict = if (source.fromLink) Integrity.SAVED_FROM_LINK else checked(source.metadata)
                    metadata += verdict
                    version += verdict
                    visit(source.within)
                }
            }
        }
        visit(sources.sources)
        return Prior(weakestCopyPrior(metadata), weakestCopyPrior(version))
    }

    /*
     * Runs another launch left behind, for the next open to offer to delete or keep what they made. Never offered: a row with
     * nothing made (it goes; its uploads are the reservations ledger's, which lets them go: Reservations), and one the person
     * already answered "delete" for that waits for a folder that may still land (only looked for, on a quiet thread of its
     * own: lookAgain). Call it off the main thread: it reads and writes the journal on disk. It never waits on the network.
     */
    fun interrupted(journal: SaveRunJournal, writer: SaveRunWriter, now: Long = System.currentTimeMillis()): List<SaveRunRow> {
        // A finished run whose row couldn't be removed is never offered, and goes now.
        journal.dropDone()
        val offered = ArrayList<SaveRunRow>()
        val answered = ArrayList<SaveRunRow>()
        for (row in journal.list().filter { it.launch != launch && !it.done }) {
            when {
                row.nodeIds.isEmpty() -> journal.retire(row)
                row.chosenDelete -> answered += row
                else -> offered += row
            }
        }
        // On the quiet thread: the rows to offer come back now, never after the network.
        if (answered.isNotEmpty()) synchronized(quietLock) {
            quietWork = quiet.submit { for (row in answered) runCatching { lookAgain(row, writer, journal, now) } }
        }
        return offered
    }

    /* Where interrupted's quiet looks run, one after another; never the caller's thread. */
    private val quiet = java.util.concurrent.Executors.newSingleThreadExecutor { work -> Thread(work, "save-runs-quiet").apply { isDaemon = true } }
    private val quietLock = Any()
    private var quietWork: java.util.concurrent.Future<*>? = null

    /* Tests only: waits for the quiet looks asked for so far. */
    internal fun quietlySettled() { synchronized(quietLock) { quietWork }?.get() }

    /*
     * An answered "delete" waiting for folders that may still land: only looked for. One found is never deleted unasked, days
     * later and perhaps filled since: the answer goes and the row is offered again with what it holds (`holds`). None found
     * once CREATION_SETTLE_MS has passed: never made, and the row goes. No answer: looked for again next launch.
     */
    private fun lookAgain(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, now: Long) {
        // Read again first, and again before writing: another launch's look, or a clean-up, may have changed the row.
        fun stillSo() = journal.live && journal.list().firstOrNull { it.id == row.id } == row
        if (!stillSo()) return
        var holds: Int? = null
        for (id in row.nodeIds) {
            writer.lookFolder(id, row.workspaceId)?.let { holds = (holds ?: 0) + it }
            if (!journal.live) return
        }
        // Compared and written in one hold of the journal's lock (swap): a Keep in between is never undone.
        if (holds != null) {
            journal.swap(row, row.copy(chosenDelete = false, holds = holds))
            return
        }
        if (row.uncertain.values.all { now - it >= CREATION_SETTLE_MS }) journal.swap(row, null)
    }

    /*
     * How long a folder creation that got no answer may still be made: an hour. Its request is given up on long before (the
     * client's timeout), and the network's retransmissions of it end well within the hour, so the server can no longer
     * receive it after. Within it, a clean-up that doesn't find the folder keeps the row; past it, one still not there was
     * never made. The web's and iOS's CREATION_SETTLE_MS.
     */
    const val CREATION_SETTLE_MS = 60 * 60 * 1000L

    /*
     * Removes what an interrupted run made, as a cancel would have, then its row. A folder the row still holds uncertain,
     * not found, may still be made: the row stays until a later launch finds it or CREATION_SETTLE_MS has passed.
     */
    fun cleanUp(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, now: Long = System.currentTimeMillis()): SaveCleanup {
        // Nothing asked of the server once the session ended (a sign-out), checked before every request.
        if (!journal.live) return SaveCleanup.LEFT
        val cleaned = clean(row, writer, journal, emptySet(), null, null, mayExist = row.uncertain.filterValues { now - it < CREATION_SETTLE_MS }.keys,
            stillOn = { journal.live })
        if (!journal.live) return SaveCleanup.LEFT
        // Kept only to wait for folders that may still land, all else done: the row names just those, with the person's answer,
        // and later launches only look for them (interrupted).
        val waitingOn = cleaned.onlyWaitingOn
        if (cleaned.cleanup == SaveCleanup.LEFT && waitingOn != null)
            journal.swap(row, row.copy(nodeIds = waitingOn, uploadIds = emptyList(), uncertain = row.uncertain.filterKeys { it in waitingOn },
                chosenDelete = true, holds = null))
        return cleaned.cleanup
    }

    /*
     * Keeps what an interrupted run made: its row always goes. Its open uploads are still asked to abort; one with no answer
     * (offline, an older server) is left to the server, which lets an open upload go once it expires, and one still finishing
     * lands and is kept, as asked.
     */
    fun keep(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal) {
        for (uploadId in row.uploadIds) abort(writer, uploadId, row.workspaceId)
        // The disk refusing to let it go: still offered, and Keep may be asked again.
        if (!journal.retire(row)) throw SaveRecordNotUpdated()
    }

    /* An abort's answer; never throws. */
    internal fun abort(writer: SaveRunWriter, uploadId: String, workspaceId: String) =
        runCatching { writer.abortUpload(uploadId, workspaceId) }.getOrDefault(SaveAbortFate.UNKNOWN)

    /*
     * What a clean-up did, how many new versions it found landed, how many may have, and whether new files or folders may
     * still be there (`remains`: LEFT with the row kept, NO_ACCESS out of reach).
     */
    internal data class Cleaned(val cleanup: SaveCleanup, val kept: Int, val uncertain: Int, val remains: SaveCleanup? = null, val waiting: Boolean = false,
                                val onlyWaitingOn: List<String>? = null, val held: Boolean = false)

    /*
     * Aborts every upload the row names, removes its nodes; the row goes unless something is left. `completing`: the uploads
     * whose completion was sent (null for an interrupted run: any may have been); only those can land after an abort that
     * got no answer.
     */
    internal fun clean(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, versions: Set<String>, completing: Set<String>?,
                       published: Set<String>?, asked: Map<String, SaveAbortFate> = emptyMap(), mayExist: Set<String> = emptySet(),
                       stillOn: () -> Boolean = { true }): Cleaned {
        var unsettled = false
        var denied = false
        var kept = 0
        var uncertain = 0
        var othersMayLand = false
        var held = false
        // An upload the stop already aborted with an answer isn't asked again; one that got none is.
        fun fateOf(uploadId: String) = asked[uploadId]?.takeIf { it != SaveAbortFate.UNKNOWN && it != SaveAbortFate.FINISHING }
            ?: abort(writer, uploadId, row.workspaceId)
        // Signed out meanwhile (an interrupted run's clean-up): nothing more asked of the server, nothing written.
        for (uploadId in row.uploadIds) when (if (stillOn()) fateOf(uploadId) else return Cleaned(SaveCleanup.LEFT, kept, uncertain)) {
            SaveAbortFate.UNKNOWN, SaveAbortFate.FINISHING -> {
                // No answer: once its completion was sent it may land yet, and a new version is never said not to have.
                unsettled = true
                if (completing?.contains(uploadId) != false) { if (uploadId in versions) uncertain++ else othersMayLand = true }
            }
            SaveAbortFate.HELD -> {
                // A family manager paused changes: nothing ended. The row stays, asked again after the hold.
                unsettled = true
                held = true
                if (completing?.contains(uploadId) != false) { if (uploadId in versions) uncertain++ else othersMayLand = true }
            }
            SaveAbortFate.DENIED -> {
                // No longer this person's to ask: once its completion was sent it may have landed.
                denied = true
                if (completing?.contains(uploadId) != false) { if (uploadId in versions) uncertain++ else othersMayLand = true }
            }
            SaveAbortFate.FINISHED -> if (uploadId in versions) kept++
            // A version whose completion was sent, and the upload not found: the share may have ended (a 404 for lost access),
            // not the upload gone. It may have landed.
            SaveAbortFate.GONE -> if (uploadId in versions && completing?.contains(uploadId) == true) { unsettled = true; uncertain++ }
            else -> {}
        }
        val notFound = HashSet<String>()
        if (!stillOn()) return Cleaned(SaveCleanup.LEFT, kept, uncertain)
        val discarded = discard(row.nodeIds, row.workspaceId, writer, notFound, stillOn) { held = true }
        if (!stillOn()) return Cleaned(SaveCleanup.LEFT, kept, uncertain)
        // A folder whose creation got no answer, not found now: the server may still be making it. The row stays.
        val waitingOn = mayExist.filter { it in notFound }
        val waiting = waitingOn.isNotEmpty()
        // Those folders, when they are all that keeps the row: everything else was settled.
        val onlyWaitingOn = if (waiting && !unsettled && discarded != SaveCleanup.LEFT && discarded != SaveCleanup.NO_ACCESS) waitingOn else null
        if (waiting) { unsettled = true; othersMayLand = true }
        var cleanup = discarded
        if (unsettled) cleanup = SaveCleanup.LEFT
        else if (denied && (cleanup == SaveCleanup.NOTHING || cleanup == SaveCleanup.NO_ACCESS)) cleanup = SaveCleanup.NO_ACCESS
        // Not removed: only what was sent to be published may still be there.
        val unremoved = (discarded == SaveCleanup.LEFT || discarded == SaveCleanup.NO_ACCESS) && row.nodeIds.any { published?.contains(it) != false }
        val someRemain = othersMayLand || unremoved
        // A row the disk won't retire stays as it was: the clean-up is left for the next open.
        if (cleanup != SaveCleanup.LEFT && !journal.retire(row)) cleanup = SaveCleanup.LEFT
        val remains = if (held && cleanup == SaveCleanup.LEFT) SaveCleanup.LEFT
        else if (!someRemain) null else if (cleanup == SaveCleanup.LEFT) SaveCleanup.LEFT else SaveCleanup.NO_ACCESS
        return Cleaned(cleanup, kept, uncertain, remains, waiting, onlyWaitingOn, held && cleanup == SaveCleanup.LEFT)
    }

    internal fun discard(ids: List<String>, workspaceId: String, writer: SaveRunWriter, notFound: MutableSet<String>? = null,
                         stillOn: () -> Boolean = { true }, onHeld: () -> Unit = {}): SaveCleanup {
        if (ids.isEmpty()) return SaveCleanup.NOTHING
        return try {
            if (!stillOn()) return SaveCleanup.LEFT
            val trashed = writer.trash(ids, workspaceId)
            // A family manager's pause: nothing ended, the rest is left for after the hold.
            if (ids.any { trashed[it] == SaveItemFate.HELD }) { onHeld(); return SaveCleanup.LEFT }
            notFound?.addAll(ids.filter { trashed[it] == SaveItemFate.GONE })
            val fates = ids.map { trashed[it] ?: SaveItemFate.REFUSED }
            if (fates.all { it == SaveItemFate.DENIED }) return SaveCleanup.NO_ACCESS
            if (fates.any { it == SaveItemFate.REFUSED || it == SaveItemFate.DENIED }) return SaveCleanup.LEFT
            val inTrash = ids.filter { trashed[it] == SaveItemFate.DONE }
            if (inTrash.isEmpty()) return SaveCleanup.NOTHING
            if (!stillOn()) return SaveCleanup.LEFT
            if (!writer.mayPurge(workspaceId)) return SaveCleanup.TRASHED
            if (!stillOn()) return SaveCleanup.LEFT
            val purged = writer.purge(inTrash, workspaceId)
            if (inTrash.any { purged[it] == SaveItemFate.HELD }) { onHeld(); return SaveCleanup.LEFT }
            if (inTrash.all { purged[it] == SaveItemFate.DONE || purged[it] == SaveItemFate.GONE }) SaveCleanup.DELETED else SaveCleanup.LEFT
        } catch (error: Exception) {
            SaveCleanup.LEFT
        }
    }

    internal fun isNoRoom(error: Throwable) = error is ApiError && error.status == 402

    /*
     * A creation that may have been made: no answer (no network, a timeout, a 5xx), or a 409 `conflict` for its own id
     * (minted here, so only an earlier send of the same request made it). Any other refusal the server explained (a 4xx),
     * or a failure before it was sent, settles that it wasn't.
     */
    internal fun noAnswer(error: Throwable) = error is Unreachable || error is java.io.IOException ||
        (error is ApiError && (error.status == 0 || error.status >= 500 || (error.status == 409 && error.code == "conflict")))
}

/*
 * One run. Blocking, as the data layer is; each result's upload runs on its caller's thread. The run's own state is under
 * its lock, held only for moments: a stop's network calls run outside it, so waiting() on the main thread never waits on
 * the network, and a second stop waits for the first's outcome rather than answering a placeholder.
 */
class SaveRun private constructor(
    private val writer: SaveRunWriter,
    private val journal: SaveRunJournal,
    private var row: SaveRunRow,
    private val first: Opened,
    private val shared: Boolean,
    private var thumbnails: Int,
    private val pause: (Int) -> Unit,
    private val now: () -> Long,
) {
    val id: String get() = row.id
    internal val journalEpoch: SaveRunJournal.Epoch get() = journal.epoch
    private val lock = Any()
    private val madeFolders = HashSet<String>()
    private val claimed = HashMap<String, MutableSet<String>>()
    private val settledUploads = HashSet<String>()
    private val versionUploads = HashSet<String>()
    /* Uploads whose completion was sent: only these can land after a stop that got no answer. */
    private val completing = HashSet<String>()
    /*
     * Folder creations sent and not yet answered: a stop's clean-up waits for them. Counted in the same locked turn that
     * checks `sealed` and records the id, so a stop either refuses the creation or sees it counted.
     */
    private val creating = AtomicInteger()
    /* Folders whose creation got no answer: one the clean-up doesn't find may still be made, so its row stays. */
    private val mayExist = HashSet<String>()
    /* Tests only: runs once a folder's creation is counted, before it is sent. */
    @Volatile internal var registered: (() -> Unit)? = null
    /* Nodes whose publication was sent (a folder's creation, a file's completion) or that landed. */
    private val published = HashSet<String>()
    /* New files' nodes, by their upload: what a completion publishes. */
    private val nodeOfUpload = HashMap<String, String>()
    private var stopping: CompletableFuture<SaveRunStopped>? = null
    private var sealed = false
    /* A sign-out: nothing is written, cleaned up or deleted for this run again. */
    private var abandoned = false
    private var finished = false
    private var inFlight = 0
    private var keptVersions = 0
    /* After a stop: what landed or was made too late to go with it and then couldn't be removed. */
    private var lateRow: SaveRunRow? = null

    companion object {
        /*
         * Starts a run writing into `targets` (folders for new files, files for new versions; one workspace). Each result names
         * its own sources. Throws SaveRefused before anything is made.
         */
        fun start(writer: SaveRunWriter, targets: List<Opened>, results: List<PlannedResult>, journal: SaveRunJournal,
                  pause: (Int) -> Unit = { Thread.sleep(FamilyUploads.PAUSE_MS) }, now: () -> Long = System::currentTimeMillis): SaveRun {
            val first = targets.firstOrNull() ?: throw SaveRefused(SaveRefused.Reason.READ_ONLY, "There’s nowhere to save this.")
            val ws = first.node.workspaceId
            if (targets.any { !it.node.workspaceId.equals(ws, ignoreCase = true) }) throw SaveRefused(SaveRefused.Reason.READ_ONLY, "Save into one place at a time.")
            // Once for the run, not per result.
            for (target in targets) writer.refusal(target)?.let { throw SaveRefused(SaveRefused.Reason.READ_ONLY, it) }
            // A sign-out while it starts (abandonAll can't reach a run not yet live): it never starts.
            if (!journal.live) throw SaveRuns.signedOut()
            val needed = runEstimate(results)
            val room = writer.room(ws)
            if (!journal.live) throw SaveRuns.signedOut()
            val free = when (room) {
                is SaveRoom.Own -> room.free
                is SaveRoom.Family -> room.free
                SaveRoom.Shared -> null
            }
            if (free != null && needed > free.coerceAtLeast(0L).toULong()) throw SaveRefused(SaveRefused.Reason.NO_ROOM, SaveRuns.NO_ROOM, needed, free.coerceAtLeast(0L))
            val row = SaveRunRow(UUID.randomUUID().toString(), ws, emptyList(), emptyList(), now(), SaveRuns.launch)
            try {
                journal.put(row)
            } catch (_: SaveUnrecorded) {
                throw SaveRunStopped(SaveRunStopped.Reason.FAILED, SaveRuns.UNRECORDED, SaveCleanup.NOTHING)
            }
            val thumbnails = results.count {
                when (it) {
                    is PlannedResult.Known -> it.thumbnail
                    is PlannedResult.FromSources -> it.thumbnail
                }
            }
            val run = SaveRun(writer, journal, row, first, room == SaveRoom.Shared, thumbnails, pause, now).also { SaveRuns.register(it) }
            // Signed out as it was registered: abandoned, its row gone with the account's files (or never written).
            if (!journal.live) {
                run.abandon()
                throw SaveRuns.signedOut()
            }
            return run
        }
    }

    /*
     * New work only while the run is open: one handed in during a stop is refused with it, and one handed in after its
     * account's session ended abandons it (a sign-out that didn't reach it).
     */
    private fun open() {
        if (!journal.live) abandon()
        val waiting = synchronized(lock) {
            if (finished && stopping == null) throw SaveRunRefusal("This save has finished.")
            stopping
        }
        if (waiting != null) throw waiting.get()
    }

    /*
     * After the stop, a new file or folder that landed too late to go with the rest and then couldn't be removed: a row names
     * it for the next open, the one the stop kept (its clean-up left things too) or, when that one went, a row of its own.
     * Every late one joins the same row.
     */
    private fun keepLate(nodeId: String, stopKeptRow: Boolean) = synchronized(lock) {
        if (abandoned) return@synchronized
        val late = lateRow ?: if (stopKeptRow) row else row.copy(nodeIds = emptyList(), uploadIds = emptyList())
        val next = if (nodeId in late.nodeIds) late else late.copy(nodeIds = late.nodeIds + nodeId)
        lateRow = next
        runCatching { journal.put(next) }
    }

    private fun noteBegun(ids: Vault.BegunIds, tracked: Boolean, version: Boolean) = synchronized(lock) {
        if (ids.uploadId in settledUploads) return@synchronized
        // Begun after the run stopped (or its account signed out): nothing is sent, the vault aborts it.
        if (sealed) throw IllegalStateException("This save run is stopping.")
        nodeOfUpload[ids.uploadId] = ids.nodeId
        if (version) versionUploads += ids.uploadId
        row = row.copy(uploadIds = if (ids.uploadId in row.uploadIds) row.uploadIds else row.uploadIds + ids.uploadId,
            nodeIds = if (tracked && ids.nodeId !in row.nodeIds) row.nodeIds + ids.nodeId else row.nodeIds)
        journal.put(row)
        // Stopped or signed out while it was written: nothing is sent, the vault aborts it.
        if (sealed) throw IllegalStateException("This save run is stopping.")
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    /*
     * `kept`: a new version that landed, counted in the same turn its id leaves the row, so a stop never misses it: before
     * the stop it is counted here, after it the row still names it and the clean-up counts it (its abort: finished).
     */
    private fun settled(ids: Vault.BegunIds?, landed: String?, tracked: Boolean, kept: Boolean = false) {
        ids ?: return
        synchronized(lock) {
            settledUploads += ids.uploadId
            landed?.let { published += it }
            if (sealed) return
            if (kept) keptVersions++
            var nodes = row.nodeIds
            if (tracked && landed != null && landed != ids.nodeId) nodes = nodes - ids.nodeId + landed
            row = row.copy(uploadIds = row.uploadIds - ids.uploadId, nodeIds = nodes)
            journal.put(row)
        }
    }

    private fun takeThumbnail(thumbnail: ByteArray?): ByteArray? = synchronized(lock) {
        if (thumbnail == null || thumbnail.isEmpty()) return null
        if (thumbnails <= 0) throw SaveRunRefusal("This result was planned without a thumbnail.")
        thumbnails--
        thumbnail
    }

    private fun claim(name: String, folder: Opened): String {
        val listed = synchronized(lock) { claimed[folder.id] == null && folder.id !in madeFolders }
        val names = if (listed) writer.names(folder).map { it.lowercase() } else emptyList()
        return synchronized(lock) {
            val taken = claimed.getOrPut(folder.id) { HashSet() }
            taken.addAll(names)
            UploadNames.freeName(name, taken).also { taken.add(it.lowercase()) }
        }
    }

    /* A new folder for results under the next free name in `parent` (the run's first target by default). */
    fun folder(name: String, sources: SaveSources, parent: Opened? = null): Opened = onItsWay {
        open()
        val copy = SaveRuns.signing(sources)
        val into = parent ?: first
        try {
            makeFolder(name, into, copy)
        } catch (error: Exception) {
            throw failed(error)
        }
    }

    /*
     * One of the run's own operations (folder, file, version), on its way from its first line: finish refuses while one is,
     * so a result still being prepared (its folder being listed) never meets a finished run, and no later failure of it
     * removes what finish said was saved. One begun after finish is refused.
     */
    private inline fun <T> onItsWay(work: () -> T): T {
        synchronized(lock) {
            if (finished && stopping == null) throw SaveRunRefusal("This save has finished.")
            inFlight++
        }
        try {
            return work()
        } finally {
            synchronized(lock) { inFlight-- }
        }
    }

    /*
     * A failure on the run's own way to a result (a folder's listing, a folder's creation): the run stops and cleans up as an
     * upload's failure does, all or nothing. A stale version stays what it is.
     */
    private fun failed(error: Exception): Exception {
        if (error is SaveRunStopped || error is SaveStale) return error
        synchronized(lock) { stopping }?.let { return it.get() }
        return stop(SaveRunStopped.Reason.FAILED, if (error is SaveUnrecorded) SaveRuns.UNRECORDED else error.message)
    }

    /* A new folder's id, minted and on disk before its creation is sent; a run stopping, or a refused write, throws. */
    private fun recordFolder(id: String) = synchronized(lock) {
        if (sealed) throw IllegalStateException("This save run is stopping.")
        // Uncertain until answered: a launch after a crash finds it so.
        row = row.copy(nodeIds = row.nodeIds + id, uncertain = row.uncertain + (id to now()))
        journal.put(row)
        // Stopped or signed out while it was written: the creation is not sent.
        if (sealed) throw IllegalStateException("This save run is stopping.")
        published += id
        creating.incrementAndGet()
    }

    /* A folder inside one the run made: no row of its own, but its creation is about to be sent. */
    private fun sending(id: String) = synchronized(lock) {
        if (sealed) throw IllegalStateException("This save run is stopping.")
        published += id
        creating.incrementAndGet()
    }

    /* A completion is about to be sent; once the run stopped it is not sent (the vault aborts the upload). */
    private fun completingNow(uploadId: String) = synchronized(lock) {
        if (sealed) throw IllegalStateException("This save run is stopping.")
        completing += uploadId
        nodeOfUpload[uploadId]?.let { published += it }
    }

    private fun makeFolder(name: String, into: Opened, copy: Prior?): Opened {
        val given = claim(name, into)
        open()
        // A folder inside one the run made goes with it and needs no row of its own.
        val recordIt = synchronized(lock) { into.id !in madeFolders }
        // A destination a key change is still walking takes the run: its folders wait it out as its uploads do, the folder
        // looked up again before each try.
        var parentNow = into
        var since: Long? = null
        var attempt = 0
        var madeHere: Opened? = null
        while (madeHere == null) {
            try {
                // Its id on disk before its creation is sent, or the creation is not sent.
                var sent: String? = null
                try {
                    madeHere = writer.makeFolder(parentNow, given, copy) { id ->
                        if (recordIt) recordFolder(id) else if (!journal.live) throw IllegalStateException("Signed out.") else sending(id)
                        sent = id
                        registered?.invoke()
                    }
                    sent?.let(::answered)
                } catch (error: Exception) {
                    // No answer: the server may still be making it (before the count drops, so a waiting stop sees it).
                    val id = sent
                    if (id != null && recordIt && SaveRuns.noAnswer(error)) synchronized(lock) { mayExist += id } else id?.let(::answered)
                    throw error
                } finally {
                    if (sent != null) creating.decrementAndGet()
                }
            } catch (error: Exception) {
                if (!FamilyUploads.waits(error, since != null)) throw error
                synchronized(lock) { stopping }?.let { throw it.get() }
                val start = since ?: now()
                since = start
                if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                waitOut(++attempt)
                val wait = Wait(since, attempt)
                parentNow = refreshed(parentNow, null, wait).first
                since = wait.since
                attempt = wait.attempt
            }
        }
        val made: Opened = madeHere
        if (!journal.live) abandon()
        val waiting = synchronized(lock) { stopping }
        if (waiting != null) {
            // Made while the run stopped: it goes the way the rest went, and if it cannot, a row names it (keepLate). After a
            // sign-out nothing is asked of the server or written for that account.
            val done = waiting.get()
            if (!synchronized(lock) { abandoned } && SaveRuns.discard(listOf(made.id), row.workspaceId, writer) == SaveCleanup.LEFT)
                keepLate(made.id, done.cleanup == SaveCleanup.LEFT)
            throw done
        }
        synchronized(lock) {
            madeFolders.add(made.id)
            claimed[made.id] = HashSet()
        }
        return made
    }

    /*
     * A creation answered (made, or refused with a reason): no longer uncertain in the row, written while the run may still
     * write (after a stop sealed it the mark stays, which only keeps a row a little longer than it needs).
     */
    private fun answered(id: String) = synchronized(lock) {
        if (id !in row.uncertain) return@synchronized
        row = row.copy(uncertain = row.uncertain - id)
        if (!sealed) runCatching { journal.put(row) }
    }

    /* A key change's pause; one cut short (the thread interrupted) stops the run as any other failure does. */
    private fun waitOut(attempt: Int) {
        try {
            pause(attempt)
        } catch (error: Exception) {
            val done = failed(error)
            if (error is InterruptedException) Thread.currentThread().interrupt()
            throw done
        }
    }

    /* A key change's wait: when it began and how many pauses so far. */
    private class Wait(var since: Long?, var attempt: Int)

    /*
     * After a pause for a key change: the folder and the chain above it as the server holds them now, and the file replaced.
     * A refresh the key change still holds up (a ledger that hasn't learned the new keys yet) pauses again, until
     * GIVE_UP_MS; a file gone is `stale`; anything else stops the run.
     */
    private fun refreshed(folder: Opened, replacing: Opened?, wait: Wait): Pair<Opened, Opened?> {
        while (true) {
            try {
                val folderNow = writer.refreshFolder(folder)
                val file = replacing ?: return folderNow to null
                return folderNow to (writer.fresh(file, folderNow) ?: throw SaveStale(null))
            } catch (stale: SaveStale) {
                throw stale
            } catch (error: Exception) {
                synchronized(lock) { stopping }?.let { throw it.get() }
                if (!FamilyUploads.waits(error, true)) throw stop(SaveRunStopped.Reason.FAILED, error.message)
                val start = wait.since ?: now()
                wait.since = start
                if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                waitOut(++wait.attempt)
            }
        }
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    fun file(bytes: ByteArray, name: String, mime: String?, sources: SaveSources, thumbnail: ByteArray? = null, folder: Opened? = null): Opened = onItsWay {
        open()
        val copy = SaveRuns.signing(sources)
        val thumb = takeThumbnail(thumbnail)
        val into = folder ?: first
        val given = try { claim(name, into) } catch (error: Exception) { throw failed(error) }
        open()
        val tracked = synchronized(lock) { into.id !in madeFolders }
        upload(bytes, given, mime, into, null, null, copy, thumb, tracked)
    }

    /* A new version of `file` (in `folder`), unless someone else saved since the work started from `startedFrom`. */
    fun version(bytes: ByteArray, file: Opened, folder: Opened, startedFrom: String?, sources: SaveSources, mime: String? = null,
                thumbnail: ByteArray? = null): VersionSaved = onItsWay {
        open()
        val copy = SaveRuns.signing(sources)
        val thumb = takeThumbnail(thumbnail)
        try {
            VersionSaved.Saved(upload(bytes, file.name, mime ?: file.metadata.mime, folder, file, startedFrom, copy, thumb, tracked = false))
        } catch (stale: SaveStale) {
            VersionSaved.Stale(stale.currentVersionId)
        }
    }

    private fun upload(bytes: ByteArray, name: String, mime: String?, folder: Opened, given: Opened?, startedFrom: String?, copy: Prior?,
                       thumbnail: ByteArray?, tracked: Boolean): Opened {
        // On its way as its file() or version() call (onItsWay).
        var replacing = given
        var folderNow = folder
        var since: Long? = null
        var attempt = 0
        var rekeys = 0
        while (true) {
            var started: Vault.BegunIds? = null
            val version = replacing != null
            try {
                // The begin's ids are on disk before a part is sent (a refused write aborts the upload there).
                val landed = writer.uploadResult(bytes, name, mime, folderNow, replacing, startedFrom, copy, thumbnail,
                    onBegun = { ids ->
                        started = ids
                        noteBegun(ids, tracked, version)
                    },
                    onCompleting = { uploadId -> completingNow(uploadId) })
                val recorded = runCatching { settled(started, landed.id, tracked, kept = version) }.isSuccess
                val waiting = synchronized(lock) { stopping }
                if (waiting != null) {
                    // Landed while the run stopped or after: a new file goes the way the rest went, and if it can't, a row
                    // names it for the next open (keepLate). Never after a sign-out.
                    val done = waiting.get()
                    if (tracked && !synchronized(lock) { abandoned } &&
                        SaveRuns.discard(listOf(landed.id), row.workspaceId, writer) == SaveCleanup.LEFT) keepLate(landed.id, done.cleanup == SaveCleanup.LEFT)
                    throw done
                }
                // Landed, but the row naming it wasn't written: the run stops and removes it with the rest.
                if (!recorded) throw stop(SaveRunStopped.Reason.FAILED, SaveRuns.UNRECORDED)
                return landed
            } catch (stale: SaveStale) {
                runCatching { settled(started, null, false) }
                throw stale
            } catch (landed: ResultLanded) {
                // Completed, but the server named another item than the one written: nothing to file. The run stops; its
                // row names the begun node, so a new file goes with the rest and a new version is kept (its abort: finished).
                throw stop(SaveRunStopped.Reason.FAILED)
            } catch (done: SaveRunStopped) {
                throw done
            } catch (error: Exception) {
                synchronized(lock) { stopping }?.let { throw it.get() }
                val rekeyed = error is SaveRekeyed
                if (rekeyed || FamilyUploads.waits(error, since != null)) {
                    // A key change reached the file or its folder: what this upload began is over, the file is looked up
                    // again (its keys as the server holds them now; startedFrom kept for the version check), and it is
                    // sealed afresh, after a pause while the change is still walking (apps/android/AGENTS.md, family uploads).
                    runCatching { settled(started, null, false) }
                    if (rekeyed) {
                        if (++rekeys > 3) throw stop(SaveRunStopped.Reason.FAILED, error.message)
                    } else {
                        val start = since ?: now()
                        since = start
                        if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                        waitOut(++attempt)
                    }
                    // The destination and the chain above it as the server holds them now (a family's synced again first),
                    // and the file replaced, so nothing is sealed again under keys the change replaced.
                    val wait = Wait(since, attempt)
                    val (folderFresh, replacingFresh) = refreshed(folderNow, replacing, wait)
                    folderNow = folderFresh
                    replacing = replacingFresh
                    since = wait.since
                    attempt = wait.attempt
                    continue
                }
                // Kept in the row: the stop aborts its upload and removes its node, whatever got that far.
                started?.let { runCatching { noteBegun(it, tracked, version) } }
                if (error is SaveUnrecorded) throw stop(SaveRunStopped.Reason.FAILED, SaveRuns.UNRECORDED)
                val noRoom = SaveRuns.isNoRoom(error)
                throw stop(if (noRoom) SaveRunStopped.Reason.NO_ROOM else SaveRunStopped.Reason.FAILED, if (noRoom) null else error.message)
            }
        }
    }

    /* Stops the run once: the first caller cleans up (outside the lock), every other one waits for its outcome. */
    private fun stop(reason: SaveRunStopped.Reason, failure: String? = null): SaveRunStopped {
        val (future, owner) = synchronized(lock) {
            stopping?.let { return@synchronized it to false }
            // Finished in the meantime (a cancel that checked just before finish took the lock): it was saved, and stays.
            if (finished) return SaveRunStopped(reason,
                if (keptVersions > 0 || row.nodeIds.isNotEmpty()) SaveRuns.ALREADY_SAVED else SaveRuns.CANCELLED, SaveCleanup.NOTHING, keptVersions)
            val made = CompletableFuture<SaveRunStopped>()
            stopping = made
            sealed = true
            made to true
        }
        if (!owner) return future.get()
        // The run's uploads are aborted first, so none keeps sending parts while the stop waits (a second abort in the
        // clean-up is harmless, and one answered here isn't asked again).
        val ws = synchronized(lock) { row.workspaceId }
        val asked = synchronized(lock) { row.uploadIds.toList() }.associateWith { SaveRuns.abort(writer, it, ws) }
        // Folder creations already sent settle next (a lost answer included): one the server creates after the clean-up
        // looked would otherwise be left with its row gone.
        while (creating.get() > 0) Thread.sleep(5)
        val (held, versions, keptBefore) = synchronized(lock) { Triple(row, versionUploads.toSet(), keptVersions) }
        val (sent, out) = synchronized(lock) { completing.toSet() to published.toSet() }
        val maybe = synchronized(lock) { mayExist.toSet() }
        val cleaned = SaveRuns.clean(held, writer, journal, versions, sent, out, asked, maybe)
        val total = keptBefore + cleaned.kept
        val done = SaveRunStopped(reason, SaveRuns.words(reason, shared, failure, total, cleaned.uncertain, cleaned.remains, cleaned.held), cleaned.cleanup, total,
            cleaned.uncertain)
        future.complete(done)
        return done
    }

    /* Every result is in: the row goes. Refused while one is still on its way, or once stopped. */
    fun finish() {
        val waiting = synchronized(lock) {
            stopping ?: run {
                if (inFlight > 0) throw RunBusy()
                finished = true
                sealed = true
                // Not retired: nothing more is taken in (`finished`), and finish may be asked again.
                if (!journal.retire(row)) throw SaveRecordNotUpdated()
                null
            }
        }
        if (waiting != null) throw waiting.get()
    }

    /*
     * Stops the run and removes the new files and folders it made (the caller cancels the work saving a result; one that lands
     * afterwards goes as it lands). A new version that landed is kept.
     */
    fun cancel(): SaveRunStopped {
        synchronized(lock) {
            // What it made was saved and stays: said so when there was any.
            if (finished && stopping == null)
                return SaveRunStopped(SaveRunStopped.Reason.CANCELLED, if (keptVersions > 0 || row.nodeIds.isNotEmpty()) SaveRuns.ALREADY_SAVED else SaveRuns.CANCELLED,
                    SaveCleanup.NOTHING, keptVersions)
        }
        return stop(SaveRunStopped.Reason.CANCELLED)
    }

    /* A sign-out: the run stops writing at once, asking nothing of the server (the session is ending). */
    fun abandon() = synchronized(lock) {
        if (stopping != null) return@synchronized
        sealed = true
        abandoned = true
        // Nothing is removed after a sign-out: what was sent to be published may stay.
        val uncertain = completing.count { it in versionUploads && it in row.uploadIds }
        val stays = row.nodeIds.any { it in published }
        stopping = CompletableFuture.completedFuture(
            SaveRunStopped(SaveRunStopped.Reason.SIGNED_OUT,
                SaveRuns.words(SaveRunStopped.Reason.SIGNED_OUT, shared, null, keptVersions, uncertain, if (stays) SaveCleanup.NOTHING else null),
                SaveCleanup.LEFT, keptVersions, uncertain))
    }

    /* Results on their way: the app asks before it lets a run's screen go. */
    fun waiting(): Int = synchronized(lock) { inFlight }
}

/* The vault as a run's drive. */
class VaultSaveWriter(private val vault: Vault, private val storage: () -> StorageAllowance) : SaveRunWriter {
    override fun refusal(target: Opened): String? = try {
        vault.familyTarget(target.node.workspaceId)
        null
    } catch (error: Exception) {
        if (FamilyUploads.waits(error, false)) null else error.message ?: FamilyWords.UNAVAILABLE
    }

    /*
     * The account's own Drive, a family folder, or a share. Free bytes as the server checks a begin (packages/db/src/pool.ts):
     * on an own allowance `availableBytes`; in a family's pool the server's own figure for the person's files
     * (`own.freeBytes`, the web's roomOf; an older server without it leaves the shown one, never more than there is); a
     * family folder is whole GiB on both sides.
     */
    override fun room(workspaceId: String): SaveRoom {
        val own = workspaceId.equals(vault.workspaceId, ignoreCase = true)
        val family = vault.familyOf(workspaceId)
        if (!own && family == null) return SaveRoom.Shared
        val figures = runCatching(storage).getOrNull() ?: return if (own) SaveRoom.Own(null) else SaveRoom.Family(null)
        if (own) {
            val free = figures.ownFreeBytes
            if (figures.pool == null || free == null) return SaveRoom.Own(figures.free)
            return SaveRoom.Own(free.coerceAtLeast(0L))
        }
        return SaveRoom.Family(if (figures.pool?.groupId.equals(family, ignoreCase = true)) figures.free else null)
    }

    override fun names(folder: Opened): List<String> = buildList {
        var after: String? = null
        do {
            val page = vault.api.children(folder.id, folder.node.workspaceId, after)
            // Each row as served now, never a copy this process opened before (another device may have renamed it).
            for (child in page.children) runCatching { openServed(child) }.getOrNull()?.let { add(it.name) }
            after = page.nextCursor
        } while (after != null)
    }

    override fun makeFolder(folder: Opened, name: String, copy: Prior?, minted: (String) -> Unit): Opened =
        vault.createFolder(folder.id, name, copy, result = true, onMinted = minted)

    override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                              thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit, onCompleting: (String) -> Unit): Opened =
        vault.uploadResult(bytes, name, mime, folder.id, replacing, startedFrom, copy, thumbnail = thumbnail, onBegun = onBegun, onCompleting = onCompleting)

    /* A row as the server serves it now, opened afresh (through the family's ledger in a family folder). */
    private fun openServed(node: NodeView): Opened =
        if (vault.isFamilyWorkspace(node.workspaceId)) vault.openListed(node) else vault.open(node, replace = true)

    override fun lookFolder(id: String, workspaceId: String): Int? {
        var items = 0
        var after: String? = null
        try {
            do {
                val page = vault.api.children(id, workspaceId, after)
                items += page.children.size
                after = page.nextCursor
            } while (after != null)
        } catch (_: NotFound) {
            return null
        } catch (error: ApiError) {
            // In the Trash: there, and the person decides what goes.
            if (error.status == 409 && error.code == "trashed") return 0
            throw error
        }
        return items
    }

    override fun fresh(file: Opened, folder: Opened): Opened? {
        var after: String? = null
        do {
            val page = vault.api.children(folder.id, folder.node.workspaceId, after)
            page.children.firstOrNull { it.id == file.id }?.let { return openServed(it) }
            after = page.nextCursor
        } while (after != null)
        return null
    }

    override fun refreshFolder(folder: Opened): Opened {
        resync(folder.node.workspaceId)
        val listing = vault.api.children(folder.id, folder.node.workspaceId, null)
        // The chain above first, so the folder opens under its parent's key as served now.
        for (above in listing.ancestors) runCatching { openServed(above) }
        return openServed(listing.folder)
    }

    /*
     * A family folder's family synced again, as iOS's recheck does before a retry: its member list and keys as the server
     * holds them now, so a key change another member made reaches this phone's ledger before the folder is opened through
     * it. Best effort: a sync that gets no answer leaves the ledger as it was, and the open then says whether to wait more.
     * Through the family sync that syncs through this vault (familyJudge): a vault that syncs no family writes into none.
     */
    private fun resync(workspaceId: String) {
        if (!vault.isFamilyWorkspace(workspaceId)) return
        val groupId = vault.familyOf(workspaceId) ?: return
        val sync = vault.familyJudge ?: return
        runCatching {
            sync.list().firstOrNull { it.id.equals(groupId, ignoreCase = true) }?.let { sync.sync(it) }
        }
    }

    /*
     * An upload still finishing is asked about again for about ten seconds, then UNKNOWN, never finished: the server publishes
     * its node only once the store has completed it, so it may land yet, and the row naming it stays for the next open.
     */
    override fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate = abortUpload(uploadId, workspaceId, 2_000L)

    internal fun abortUpload(uploadId: String, workspaceId: String, pauseMs: Long): SaveAbortFate {
        repeat(5) { asked ->
            val fate = vault.api.abortUploadFate(uploadId, workspaceId)
            if (fate != SaveAbortFate.FINISHING) return fate
            if (asked < 4) Thread.sleep(pauseMs)
        }
        return SaveAbortFate.UNKNOWN
    }

    /*
     * A write like any other (apps/android/AGENTS.md, family folders): in its own `writing` scope, deciding at its entry
     * whether it writes as a family's (familyTarget), so the final gate lets a family folder's clean-up through, and refuses
     * it (the clean-up left for later) while the folder may not be written.
     */
    override fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> = writing {
        vault.familyTarget(workspaceId)
        trashNow(ids, workspaceId)
    }

    private fun trashNow(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> {
        val fates = HashMap<String, SaveItemFate>()
        for (batch in ids.chunked(MAX_TRASH_BATCH)) {
            val answers = try {
                vault.api.trashBatch(workspaceId, batch)
            } catch (error: Exception) {
                // A family manager's pause is not lost access: kept for after the hold.
                if (error is ApiError && error.status == 403 && error.code == "held") { batch.forEach { fates[it] = SaveItemFate.HELD }; continue }
                if (error is NotFound || (error is ApiError && error.status == 403)) { batch.forEach { fates[it] = SaveItemFate.DENIED }; continue }
                throw error
            }
            for (answer in answers) fates[answer.id] = when (answer) {
                is Trashed, is Covered -> SaveItemFate.DONE
                is BatchRefusal -> when (answer.reason) {
                    "trashed" -> SaveItemFate.DONE
                    "not-found" -> SaveItemFate.GONE
                    else -> SaveItemFate.REFUSED
                }
                else -> SaveItemFate.REFUSED
            }
        }
        return fates
    }

    /* As trash: a write in its own scope, through the family's gate. */
    override fun purge(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> = writing {
        vault.familyTarget(workspaceId)
        purgeNow(ids, workspaceId)
    }

    private fun purgeNow(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> = ids.associateWith { id ->
        try {
            vault.api.purge(id, workspaceId)
            SaveItemFate.DONE
        } catch (error: NotFound) {
            SaveItemFate.GONE
        } catch (error: ApiError) {
            if (error.status == 403 && error.code == "held") SaveItemFate.HELD
            else if (error.status == 403) SaveItemFate.DENIED else if (error.status == 0 || error.status >= 500) throw error else SaveItemFate.REFUSED
        }
    }

    override fun mayPurge(workspaceId: String): Boolean =
        workspaceId.equals(vault.workspaceId, ignoreCase = true) || vault.isFamilyWorkspace(workspaceId)

    companion object {
        const val MAX_TRASH_BATCH = 200
    }
}
