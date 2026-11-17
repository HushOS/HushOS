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

/* A run's row: ids only, never a name or a byte. `launch` is the process that ran it. */
data class SaveRunRow(val id: String, val workspaceId: String, val nodeIds: List<String>, val uploadIds: List<String>, val at: Long, val launch: String) {
    fun json(): JSONObject = JSONObject().put("id", id).put("workspaceId", workspaceId).put("nodeIds", JSONArray(nodeIds))
        .put("uploadIds", JSONArray(uploadIds)).put("at", at).put("launch", launch)

    companion object {
        fun from(json: JSONObject): SaveRunRow {
            fun list(name: String) = json.getJSONArray(name).let { array -> (0 until array.length()).map(array::getString) }
            return SaveRunRow(json.getString("id"), json.getString("workspaceId"), list("nodeIds"), list("uploadIds"), json.getLong("at"), json.getString("launch"))
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

    /* Whether this journal still belongs to the session it was opened in. */
    val live: Boolean get() = born == epoch.current

    @Synchronized fun list(): List<SaveRunRow> = read()

    @Synchronized fun put(row: SaveRunRow) { if (live) write(read().filter { it.id != row.id } + row) }

    @Synchronized fun remove(id: String) { if (live) write(read().filter { it.id != id }) }

    private fun read(): List<SaveRunRow> = runCatching {
        val array = JSONArray(file.readText())
        (0 until array.length()).map { SaveRunRow.from(array.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    private fun write(rows: List<SaveRunRow>) {
        if (rows.isEmpty()) { file.delete(); return }
        file.parentFile?.mkdirs()
        val next = File(file.parentFile, file.name + ".tmp")
        next.writeText(JSONArray(rows.map { it.json() }).toString())
        if (!next.renameTo(file)) { file.delete(); next.renameTo(file) }
    }

    companion object {
        const val FILE = "save-runs.json"
        val account = Epoch()
        fun of(context: android.content.Context) = SaveRunJournal(File(context.filesDir, FILE))

        /* Sign-out, deletion, removal: no journal opened before writes again (the file goes with the account's files). */
        fun endAccount() = account.end()
    }
}

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
enum class SaveItemFate { DONE, GONE, REFUSED, DENIED }

/*
 * The server's answer to an abort (`data.upload` naming a finishing and a finished upload, packages/drive/src/server.ts):
 * FINISHING is asked about again; UNKNOWN is no answer.
 */
enum class SaveAbortFate { ABORTED, GONE, FINISHED, FINISHING, DENIED, UNKNOWN }

/* What a run asks of the drive. The vault is one (VaultSaveWriter); tests stand one in. */
interface SaveRunWriter {
    /* Why `target` may not be written now, or null; a key change still walking it is no refusal (uploads wait it out). */
    fun refusal(target: Opened): String?
    fun room(workspaceId: String): SaveRoom
    fun names(folder: Opened): List<String>
    fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened
    fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                     thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit): Opened
    /* `file` as the server lists its folder now (its keys after a key change), or null when it is no longer there. */
    fun fresh(file: Opened, folder: Opened): Opened?
    /* `folder` and the chain above it as the server holds them now, to seal afresh under. */
    fun refreshFolder(folder: Opened): Opened
    /* Never FINISHING: an upload still completing is asked about again, then taken as finished. */
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

/* Why a run stopped after it started, what its clean-up did, and how many new versions had landed and were kept. */
class SaveRunStopped(val reason: Reason, message: String, val cleanup: SaveCleanup, val keptVersions: Int = 0) : Exception(message) {
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

    /* What a stopped run says: never "nothing was saved" once a new version landed (the web's stoppedWords). */
    fun words(reason: SaveRunStopped.Reason, shared: Boolean, failure: String?, kept: Int): String {
        val opening = when (reason) {
            SaveRunStopped.Reason.CANCELLED -> "Cancelled."
            SaveRunStopped.Reason.NO_ROOM -> if (shared) "There isn’t enough room in this shared folder for this." else "There isn’t enough room for this."
            SaveRunStopped.Reason.SIGNED_OUT -> "You signed out before this was saved."
            SaveRunStopped.Reason.FAILED -> (failure ?: "This couldn’t be saved.").trim()
        }
        if (kept == 0) return if (reason == SaveRunStopped.Reason.FAILED && failure == null) FAILED else "$opening Nothing was saved."
        val versions = if (kept == 1) "The new version saved before that was kept." else "The $kept new versions saved before that were kept."
        return "$opening $versions Nothing else was saved."
    }

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

    /* Runs another launch left behind, for the next open to offer to delete or keep what they made. */
    fun interrupted(journal: SaveRunJournal): List<SaveRunRow> = journal.list().filter { it.launch != launch }

    /* Removes what an interrupted run made, as a cancel would have, then its row. */
    fun cleanUp(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal): SaveCleanup = clean(row, writer, journal, emptySet()).first

    /* Keeps what an interrupted run made: its row goes, its open uploads aborted (without an answer, the row stays). */
    fun keep(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal): Boolean {
        for (uploadId in row.uploadIds) if (abort(writer, uploadId, row.workspaceId) == SaveAbortFate.UNKNOWN) return false
        journal.remove(row.id)
        return true
    }

    private fun abort(writer: SaveRunWriter, uploadId: String, workspaceId: String) =
        runCatching { writer.abortUpload(uploadId, workspaceId) }.getOrDefault(SaveAbortFate.UNKNOWN)

    /* Aborts every upload the row names, removes its nodes; the row goes unless something is left. */
    internal fun clean(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, versions: Set<String>): Pair<SaveCleanup, Int> {
        var unsettled = false
        var denied = false
        var kept = 0
        for (uploadId in row.uploadIds) when (abort(writer, uploadId, row.workspaceId)) {
            SaveAbortFate.UNKNOWN, SaveAbortFate.FINISHING -> unsettled = true
            SaveAbortFate.DENIED -> denied = true
            SaveAbortFate.FINISHED -> if (uploadId in versions) kept++
            else -> {}
        }
        var cleanup = discard(row.nodeIds, row.workspaceId, writer)
        if (unsettled) cleanup = SaveCleanup.LEFT
        else if (denied && (cleanup == SaveCleanup.NOTHING || cleanup == SaveCleanup.NO_ACCESS)) cleanup = SaveCleanup.NO_ACCESS
        if (cleanup != SaveCleanup.LEFT) journal.remove(row.id)
        return cleanup to kept
    }

    internal fun discard(ids: List<String>, workspaceId: String, writer: SaveRunWriter): SaveCleanup {
        if (ids.isEmpty()) return SaveCleanup.NOTHING
        return try {
            val trashed = writer.trash(ids, workspaceId)
            val fates = ids.map { trashed[it] ?: SaveItemFate.REFUSED }
            if (fates.all { it == SaveItemFate.DENIED }) return SaveCleanup.NO_ACCESS
            if (fates.any { it == SaveItemFate.REFUSED || it == SaveItemFate.DENIED }) return SaveCleanup.LEFT
            val inTrash = ids.filter { trashed[it] == SaveItemFate.DONE }
            if (inTrash.isEmpty()) return SaveCleanup.NOTHING
            if (!writer.mayPurge(workspaceId)) return SaveCleanup.TRASHED
            val purged = writer.purge(inTrash, workspaceId)
            if (inTrash.all { purged[it] == SaveItemFate.DONE || purged[it] == SaveItemFate.GONE }) SaveCleanup.DELETED else SaveCleanup.LEFT
        } catch (error: Exception) {
            SaveCleanup.LEFT
        }
    }

    internal fun isNoRoom(error: Throwable) = error is ApiError && error.status == 402
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
    private var stopping: CompletableFuture<SaveRunStopped>? = null
    private var sealed = false
    /* A sign-out: nothing is written, cleaned up or deleted for this run again. */
    private var abandoned = false
    private var finished = false
    private var inFlight = 0
    private var keptVersions = 0

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
            val needed = runEstimate(results)
            val room = writer.room(ws)
            val free = when (room) {
                is SaveRoom.Own -> room.free
                is SaveRoom.Family -> room.free
                SaveRoom.Shared -> null
            }
            if (free != null && needed > free.coerceAtLeast(0L).toULong()) throw SaveRefused(SaveRefused.Reason.NO_ROOM, SaveRuns.NO_ROOM, needed, free.coerceAtLeast(0L))
            val row = SaveRunRow(UUID.randomUUID().toString(), ws, emptyList(), emptyList(), now(), SaveRuns.launch)
            journal.put(row)
            val thumbnails = results.count {
                when (it) {
                    is PlannedResult.Known -> it.thumbnail
                    is PlannedResult.FromSources -> it.thumbnail
                }
            }
            return SaveRun(writer, journal, row, first, room == SaveRoom.Shared, thumbnails, pause, now).also { SaveRuns.register(it) }
        }
    }

    /* New work only while the run is open: one handed in during a stop is refused with it. */
    private fun open() {
        val waiting = synchronized(lock) {
            if (finished && stopping == null) throw SaveRunStopped(SaveRunStopped.Reason.FAILED, "This save has finished.", SaveCleanup.NOTHING)
            stopping
        }
        if (waiting != null) throw waiting.get()
    }

    private fun change(body: (SaveRunRow) -> SaveRunRow) = synchronized(lock) {
        if (sealed) return@synchronized
        row = body(row)
        journal.put(row)
    }

    private fun noteBegun(ids: Vault.BegunIds, tracked: Boolean, version: Boolean) = synchronized(lock) {
        if (sealed || ids.uploadId in settledUploads) return@synchronized
        if (version) versionUploads += ids.uploadId
        row = row.copy(uploadIds = if (ids.uploadId in row.uploadIds) row.uploadIds else row.uploadIds + ids.uploadId,
            nodeIds = if (tracked && ids.nodeId !in row.nodeIds) row.nodeIds + ids.nodeId else row.nodeIds)
        journal.put(row)
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    private fun settled(ids: Vault.BegunIds?, landed: String?, tracked: Boolean) {
        ids ?: return
        synchronized(lock) {
            settledUploads += ids.uploadId
            if (sealed) return
            var nodes = row.nodeIds
            if (tracked && landed != null && landed != ids.nodeId) nodes = nodes - ids.nodeId + landed
            row = row.copy(uploadIds = row.uploadIds - ids.uploadId, nodeIds = nodes)
            journal.put(row)
        }
    }

    private fun takeThumbnail(thumbnail: ByteArray?): ByteArray? = synchronized(lock) {
        if (thumbnail == null || thumbnail.isEmpty()) return null
        if (thumbnails <= 0) throw SaveRunStopped(SaveRunStopped.Reason.FAILED, "This result was planned without a thumbnail.", SaveCleanup.NOTHING)
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
    fun folder(name: String, sources: SaveSources, parent: Opened? = null): Opened {
        open()
        val copy = SaveRuns.signing(sources)
        val into = parent ?: first
        val given = claim(name, into)
        open()
        // A destination a key change is still walking takes the run: its folders wait it out as its uploads do, the folder
        // looked up again before each try.
        var parentNow = into
        var since: Long? = null
        var attempt = 0
        var madeHere: Opened? = null
        while (madeHere == null) {
            try {
                madeHere = writer.makeFolder(parentNow, given, copy)
            } catch (error: Exception) {
                if (!FamilyUploads.waits(error, since != null)) throw error
                synchronized(lock) { stopping }?.let { throw it.get() }
                val start = since ?: now()
                since = start
                if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                pause(++attempt)
                parentNow = writer.refreshFolder(parentNow)
            }
        }
        val made: Opened = madeHere
        val waiting = synchronized(lock) { stopping }
        if (waiting != null) {
            // Made while the run stopped: it goes the way the rest went, and if it cannot, a row names it: added to the row the
            // stop kept (its clean-up left things too), or a row of its own when the stop's went.
            val done = waiting.get()
            if (!synchronized(lock) { abandoned } && SaveRuns.discard(listOf(made.id), row.workspaceId, writer) == SaveCleanup.LEFT)
                journal.put(if (done.cleanup == SaveCleanup.LEFT) row.copy(nodeIds = row.nodeIds + made.id) else row.copy(nodeIds = listOf(made.id), uploadIds = emptyList()))
            throw done
        }
        synchronized(lock) {
            madeFolders.add(made.id)
            claimed[made.id] = HashSet()
        }
        if (into.id !in madeFolders) change { it.copy(nodeIds = it.nodeIds + made.id) }
        return made
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    fun file(bytes: ByteArray, name: String, mime: String?, sources: SaveSources, thumbnail: ByteArray? = null, folder: Opened? = null): Opened {
        open()
        val copy = SaveRuns.signing(sources)
        val thumb = takeThumbnail(thumbnail)
        val into = folder ?: first
        val given = claim(name, into)
        open()
        val tracked = synchronized(lock) { into.id !in madeFolders }
        return upload(bytes, given, mime, into, null, null, copy, thumb, tracked)
    }

    /* A new version of `file` (in `folder`), unless someone else saved since the work started from `startedFrom`. */
    fun version(bytes: ByteArray, file: Opened, folder: Opened, startedFrom: String?, sources: SaveSources, mime: String? = null,
                thumbnail: ByteArray? = null): VersionSaved {
        open()
        val copy = SaveRuns.signing(sources)
        val thumb = takeThumbnail(thumbnail)
        return try {
            VersionSaved.Saved(upload(bytes, file.name, mime ?: file.metadata.mime, folder, file, startedFrom, copy, thumb, tracked = false))
        } catch (stale: SaveStale) {
            VersionSaved.Stale(stale.currentVersionId)
        }
    }

    private fun upload(bytes: ByteArray, name: String, mime: String?, folder: Opened, given: Opened?, startedFrom: String?, copy: Prior?,
                       thumbnail: ByteArray?, tracked: Boolean): Opened {
        synchronized(lock) { inFlight++ }
        try {
            var replacing = given
            var folderNow = folder
            var since: Long? = null
            var attempt = 0
            var rekeys = 0
            while (true) {
                var started: Vault.BegunIds? = null
                val version = replacing != null
                try {
                    val landed = writer.uploadResult(bytes, name, mime, folderNow, replacing, startedFrom, copy, thumbnail) { ids ->
                        started = ids
                        noteBegun(ids, tracked, version)
                    }
                    settled(started, landed.id, tracked)
                    val waiting = synchronized(lock) {
                        if (version) keptVersions++
                        stopping
                    }
                    if (waiting != null) {
                        // Landed while the run stopped or after: a new file goes the way the rest went (never after a sign-out).
                        val done = waiting.get()
                        if (tracked && !synchronized(lock) { abandoned }) SaveRuns.discard(listOf(landed.id), row.workspaceId, writer)
                        throw done
                    }
                    return landed
                } catch (stale: SaveStale) {
                    settled(started, null, false)
                    throw stale
                } catch (landed: ResultLanded) {
                    // It landed, though its row couldn't be finished here: a version kept, a new file the run keeps naming.
                    settled(started, landed.nodeId, tracked)
                    synchronized(lock) { if (version) keptVersions++ }
                    throw landed
                } catch (done: SaveRunStopped) {
                    throw done
                } catch (error: Exception) {
                    synchronized(lock) { stopping }?.let { throw it.get() }
                    val rekeyed = error is SaveRekeyed
                    if (rekeyed || FamilyUploads.waits(error, since != null)) {
                        // A key change reached the file or its folder: what this upload began is over, the file is looked up
                        // again (its keys as the server holds them now; startedFrom kept for the version check), and it is
                        // sealed afresh, after a pause while the change is still walking (apps/android/AGENTS.md, family uploads).
                        settled(started, null, false)
                        if (rekeyed) {
                            if (++rekeys > 3) throw stop(SaveRunStopped.Reason.FAILED, error.message)
                        } else {
                            val start = since ?: now()
                            since = start
                            if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                            pause(++attempt)
                        }
                        // The destination and the chain above it as the server holds them now, and the file replaced, so
                        // nothing is sealed again under keys the change replaced.
                        folderNow = writer.refreshFolder(folderNow)
                        replacing?.let { file -> replacing = writer.fresh(file, folderNow) ?: throw SaveStale(null) }
                        continue
                    }
                    // Kept in the row: the stop aborts its upload and removes its node, whatever got that far.
                    started?.let { noteBegun(it, tracked, version) }
                    val noRoom = SaveRuns.isNoRoom(error)
                    throw stop(if (noRoom) SaveRunStopped.Reason.NO_ROOM else SaveRunStopped.Reason.FAILED, if (noRoom) null else error.message)
                }
            }
        } finally {
            synchronized(lock) { inFlight-- }
        }
    }

    /* Stops the run once: the first caller cleans up (outside the lock), every other one waits for its outcome. */
    private fun stop(reason: SaveRunStopped.Reason, failure: String? = null): SaveRunStopped {
        val (future, owner) = synchronized(lock) {
            stopping?.let { return@synchronized it to false }
            val made = CompletableFuture<SaveRunStopped>()
            stopping = made
            sealed = true
            made to true
        }
        if (!owner) return future.get()
        val (held, versions, keptBefore) = synchronized(lock) { Triple(row, versionUploads.toSet(), keptVersions) }
        val (cleanup, kept) = SaveRuns.clean(held, writer, journal, versions)
        val total = keptBefore + kept
        val done = SaveRunStopped(reason, SaveRuns.words(reason, shared, failure, total), cleanup, total)
        future.complete(done)
        return done
    }

    /* Every result is in: the row goes. Refused while one is still on its way, or once stopped. */
    fun finish() {
        val waiting = synchronized(lock) {
            stopping ?: run {
                if (inFlight > 0) throw SaveRunStopped(SaveRunStopped.Reason.FAILED, "Some results are still being saved.", SaveCleanup.NOTHING)
                finished = true
                sealed = true
                journal.remove(row.id)
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
            if (finished && stopping == null) return SaveRunStopped(SaveRunStopped.Reason.CANCELLED, SaveRuns.CANCELLED, SaveCleanup.NOTHING, keptVersions)
        }
        return stop(SaveRunStopped.Reason.CANCELLED)
    }

    /* A sign-out: the run stops writing at once, asking nothing of the server (the session is ending). */
    fun abandon() = synchronized(lock) {
        if (stopping != null) return@synchronized
        sealed = true
        abandoned = true
        stopping = CompletableFuture.completedFuture(
            SaveRunStopped(SaveRunStopped.Reason.SIGNED_OUT, SaveRuns.words(SaveRunStopped.Reason.SIGNED_OUT, shared, null, keptVersions), SaveCleanup.LEFT, keptVersions))
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
            for (child in page.children) runCatching { vault.open(child) }.getOrNull()?.let { add(it.name) }
            after = page.nextCursor
        } while (after != null)
    }

    override fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened = vault.createFolder(folder.id, name, copy, result = true)

    override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                              thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit): Opened =
        vault.uploadResult(bytes, name, mime, folder.id, replacing, startedFrom, copy, thumbnail = thumbnail, onBegun = onBegun)

    /* A row as the server serves it now, opened afresh (through the family's ledger in a family folder). */
    private fun openServed(node: NodeView): Opened =
        if (vault.isFamilyWorkspace(node.workspaceId)) vault.openListed(node) else vault.open(node, replace = true)

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
        val listing = vault.api.children(folder.id, folder.node.workspaceId, null)
        // The chain above first, so the folder opens under its parent's key as served now.
        for (above in listing.ancestors) runCatching { openServed(above) }
        return openServed(listing.folder)
    }

    /* An upload still finishing is asked about again for about ten seconds, then taken as finished: it lands. */
    override fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate {
        repeat(5) { asked ->
            val fate = vault.api.abortUploadFate(uploadId, workspaceId)
            if (fate != SaveAbortFate.FINISHING) return fate
            if (asked < 4) Thread.sleep(2_000)
        }
        return SaveAbortFate.FINISHED
    }

    override fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> {
        val fates = HashMap<String, SaveItemFate>()
        for (batch in ids.chunked(MAX_TRASH_BATCH)) {
            val answers = try {
                vault.api.trashBatch(workspaceId, batch)
            } catch (error: Exception) {
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

    override fun purge(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> = ids.associateWith { id ->
        try {
            vault.api.purge(id, workspaceId)
            SaveItemFate.DONE
        } catch (error: NotFound) {
            SaveItemFate.GONE
        } catch (error: ApiError) {
            if (error.status == 403) SaveItemFate.DENIED else if (error.status == 0 || error.status >= 500) throw error else SaveItemFate.REFUSED
        }
    }

    override fun mayPurge(workspaceId: String): Boolean =
        workspaceId.equals(vault.workspaceId, ignoreCase = true) || vault.isFamilyWorkspace(workspaceId)

    companion object {
        const val MAX_TRASH_BATCH = 200
    }
}
