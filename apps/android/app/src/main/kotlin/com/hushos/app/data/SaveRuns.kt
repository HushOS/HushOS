package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.PlannedResult
import com.hushos.core.runEstimate
import com.hushos.core.weakestCopyPrior
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/*
 * The save path on the phone (docs/file-tools-design.md section 2, the web's packages/drive/src/save-runs.ts, iOS's
 * SaveRuns.swift): how File tools and editing write what they produce. Two modes: a new version of the same file, which a
 * version race ends `stale` (never a conflict copy), and a new file under the next free name in its folder, which never
 * replaces anything.
 *
 * A run asks its destination once whether it may be written and whether its results fit (padded ciphertext, by the core's
 * estimate, against the free space where that is the person's to know). Results upload from memory, never a temporary
 * plaintext file, and never resume. One row of ids per run (SaveRunRow) lets a cancel, a refusal, a 402, a failure or a
 * killed app leave nothing behind: open uploads aborted, what was published deleted forever, or moved to the Trash where
 * the person may not delete forever (an editor in someone else's share).
 *
 * Family folders: a result signed by its sources is a copy, and this app offers no copy into a family folder
 * (Vault.uploadInside's rule), so such a run is refused at its start, with that rule's words. A result that is the
 * person's own writing (`copy` null) goes into one, waiting out a key change still walking it.
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

/* The rows, under filesDir: deleted with the account's files at sign-out (AccountStore.ACCOUNT_FILES). */
class SaveRunJournal(val file: File) {
    @Synchronized fun list(): List<SaveRunRow> = read()

    @Synchronized fun put(row: SaveRunRow) = write(read().filter { it.id != row.id } + row)

    @Synchronized fun remove(id: String) = write(read().filter { it.id != id })

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
        fun of(context: android.content.Context) = SaveRunJournal(File(context.filesDir, FILE))
    }
}

/* What a run asks of the drive. The vault is one (VaultSaveWriter); tests stand one in. */
interface SaveRunWriter {
    /* Why `target` may not be written now, or null; a key change still walking it is no refusal (uploads wait it out). */
    fun refusal(target: Opened, copy: Prior?): String?
    /* Free bytes of a workspace, or null when they are not this person's to know (someone else's share). */
    fun freeSpace(workspaceId: String): Long?
    fun names(folder: Opened): List<String>
    fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened
    fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                     onBegun: (Vault.BegunIds) -> Unit): Opened
    fun abortUpload(uploadId: String, workspaceId: String)
    fun trash(ids: List<String>, workspaceId: String)
    fun purge(ids: List<String>, workspaceId: String)
    /* Whether the server lets this person delete forever there: a member (their own Drive, a family's folder). */
    fun mayPurge(workspaceId: String): Boolean
}

enum class SaveCleanup { DELETED, TRASHED, NOTHING, LEFT }

/* Why a run did not start: nothing was made. `needed` and `free` only in the person's own space, never a share. */
class SaveRefused(val reason: Reason, message: String, val needed: ULong? = null, val free: Long? = null) : Exception(message) {
    enum class Reason { READ_ONLY, NO_ROOM }
}

/* Why a run stopped after it started, and what its clean-up did. */
class SaveRunStopped(val reason: Reason, message: String, val cleanup: SaveCleanup) : Exception(message) {
    enum class Reason { CANCELLED, NO_ROOM, FAILED }
}

sealed class VersionSaved {
    data class Saved(val item: Opened) : VersionSaved()
    data class Stale(val currentVersionId: String?) : VersionSaved()
}

object SaveRuns {
    const val NO_ROOM = "There isn’t enough room for this. Nothing was saved."
    const val NO_ROOM_SHARED = "There isn’t enough room in this shared folder for this. Nothing was saved."
    const val CANCELLED = "Cancelled. Nothing was saved."

    /* This process: a row another launch left is interrupted, one of this launch's is a live run's. */
    val launch: String = UUID.randomUUID().toString()

    /*
     * What a result made from `sources` is signed as a copy of: record by record, the weakest of their verdicts (the
     * core's weakestCopyPrior). A source saved from a link counts as SAVED_FROM_LINK, as the core signs it.
     */
    fun signing(sources: List<Prior>): Prior {
        fun verdicts(pick: (Prior) -> Integrity) = sources.map { if (it.fromLink) Integrity.SAVED_FROM_LINK else pick(it) }
        return Prior(weakestCopyPrior(verdicts { it.metadata }), weakestCopyPrior(verdicts { it.version }))
    }

    /* Runs another launch left behind, for the next open to offer to delete what they made. */
    fun interrupted(journal: SaveRunJournal): List<SaveRunRow> = journal.list().filter { it.launch != launch }

    /* Removes what an interrupted run made, as a cancel would have, then its row. */
    fun cleanUp(row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal): SaveCleanup {
        for (uploadId in row.uploadIds) runCatching { writer.abortUpload(uploadId, row.workspaceId) }
        val cleanup = discard(row.nodeIds, row.workspaceId, writer)
        if (cleanup != SaveCleanup.LEFT) journal.remove(row.id)
        return cleanup
    }

    internal fun discard(ids: List<String>, workspaceId: String, writer: SaveRunWriter): SaveCleanup {
        if (ids.isEmpty()) return SaveCleanup.NOTHING
        return try {
            writer.trash(ids, workspaceId)
            if (!writer.mayPurge(workspaceId)) return SaveCleanup.TRASHED
            writer.purge(ids, workspaceId)
            SaveCleanup.DELETED
        } catch (error: Exception) {
            SaveCleanup.LEFT
        }
    }

    internal fun isNoRoom(error: Throwable) = error is ApiError && error.status == 402
}

/*
 * One run. Blocking, as the data layer is; called from one worker at a time, or from several (each result's upload runs on
 * the caller's thread), the run's own state under its lock.
 */
class SaveRun private constructor(
    private val writer: SaveRunWriter,
    private val journal: SaveRunJournal,
    private var row: SaveRunRow,
    private val first: Opened,
    private val shared: Boolean,
    val copy: Prior?,
    private val pause: (Int) -> Unit,
    private val now: () -> Long,
) {
    val id: String get() = row.id
    private val lock = Any()
    private val madeFolders = HashSet<String>()
    private val claimed = HashMap<String, MutableSet<String>>()
    @Volatile private var stopped: SaveRunStopped? = null
    private var finished = false
    private var inFlight = 0

    companion object {
        /*
         * Starts a run writing into `targets` (folders for new files, files for new versions; one workspace), signed as `copy`
         * (SaveRuns.signing of its sources, or null for the person's own writing). Throws SaveRefused before anything is made.
         */
        fun start(writer: SaveRunWriter, targets: List<Opened>, results: List<PlannedResult>, copy: Prior?, journal: SaveRunJournal,
                  pause: (Int) -> Unit = { Thread.sleep(FamilyUploads.PAUSE_MS) }, now: () -> Long = System::currentTimeMillis): SaveRun {
            val first = targets.firstOrNull() ?: throw SaveRefused(SaveRefused.Reason.READ_ONLY, "There’s nowhere to save this.")
            val ws = first.node.workspaceId
            if (targets.any { !it.node.workspaceId.equals(ws, ignoreCase = true) }) throw SaveRefused(SaveRefused.Reason.READ_ONLY, "Save into one place at a time.")
            // Once for the run, not per result.
            for (target in targets) writer.refusal(target, copy)?.let { throw SaveRefused(SaveRefused.Reason.READ_ONLY, it) }
            val needed = runEstimate(results)
            val free = writer.freeSpace(ws)
            if (free != null && needed > free.coerceAtLeast(0L).toULong()) throw SaveRefused(SaveRefused.Reason.NO_ROOM, SaveRuns.NO_ROOM, needed, free.coerceAtLeast(0L))
            val row = SaveRunRow(UUID.randomUUID().toString(), ws, emptyList(), emptyList(), now(), SaveRuns.launch)
            journal.put(row)
            return SaveRun(writer, journal, row, first, free == null, copy, pause, now)
        }
    }

    private fun check() {
        stopped?.let { throw it }
        synchronized(lock) { if (finished) throw SaveRunStopped(SaveRunStopped.Reason.FAILED, "This save has finished.", SaveCleanup.NOTHING) }
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
    fun folder(name: String, parent: Opened? = null): Opened {
        check()
        val into = parent ?: first
        val made = writer.makeFolder(into, claim(name, into), copy)
        stopped?.let { done ->
            SaveRuns.discard(listOf(made.id), row.workspaceId, writer)
            throw done
        }
        synchronized(lock) {
            madeFolders.add(made.id)
            claimed[made.id] = HashSet()
            if (into.id !in madeFolders) keep { it.copy(nodeIds = it.nodeIds + made.id) }
        }
        return made
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    fun file(bytes: ByteArray, name: String, mime: String?, folder: Opened? = null): Opened {
        check()
        val into = folder ?: first
        val given = claim(name, into)
        val tracked = synchronized(lock) { into.id !in madeFolders }
        return upload(bytes, given, mime, into, null, null, tracked)
    }

    /* A new version of `file` (in `folder`), unless someone else saved since the work started from `startedFrom`. */
    fun version(bytes: ByteArray, file: Opened, folder: Opened, startedFrom: String?, mime: String? = null): VersionSaved {
        check()
        return try {
            VersionSaved.Saved(upload(bytes, file.name, mime ?: file.metadata.mime, folder, file, startedFrom, tracked = false))
        } catch (stale: SaveStale) {
            VersionSaved.Stale(stale.currentVersionId)
        }
    }

    private fun keep(change: (SaveRunRow) -> SaveRunRow) {
        row = change(row)
        if (stopped == null && !finished) journal.put(row)
    }

    private fun upload(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, tracked: Boolean): Opened {
        synchronized(lock) { inFlight++ }
        var begun: Vault.BegunIds? = null
        try {
            var since: Long? = null
            var attempt = 0
            while (true) {
                try {
                    val landed = writer.uploadResult(bytes, name, mime, folder, replacing, startedFrom, copy) { ids ->
                        begun = ids
                        synchronized(lock) {
                            keep { current ->
                                current.copy(uploadIds = current.uploadIds + ids.uploadId, nodeIds = if (tracked) current.nodeIds + ids.nodeId else current.nodeIds)
                            }
                        }
                    }
                    settled(begun, landed.id, tracked)
                    stopped?.let { done ->
                        // Landed after the run was cancelled: it goes the way the rest went.
                        if (tracked) SaveRuns.discard(listOf(landed.id), row.workspaceId, writer)
                        throw done
                    }
                    return landed
                } catch (stale: SaveStale) {
                    settled(begun, null, false)
                    throw stale
                } catch (done: SaveRunStopped) {
                    throw done
                } catch (error: Exception) {
                    stopped?.let { throw it }
                    if (FamilyUploads.waits(error, since != null)) {
                        settled(begun, null, false)
                        begun = null
                        // A family folder a key change hasn't reached: the run waits it out, as the queue does.
                        val start = since ?: now()
                        since = start
                        if (now() - start >= FamilyUploads.GIVE_UP_MS) throw stop(SaveRunStopped.Reason.FAILED, FamilyUploads.GAVE_UP)
                        attempt += 1
                        pause(attempt)
                        continue
                    }
                    val noRoom = SaveRuns.isNoRoom(error)
                    throw stop(
                        if (noRoom) SaveRunStopped.Reason.NO_ROOM else SaveRunStopped.Reason.FAILED,
                        if (noRoom) (if (shared) SaveRuns.NO_ROOM_SHARED else SaveRuns.NO_ROOM) else error.message ?: "This couldn’t be saved, so nothing was kept.",
                    )
                }
            }
        } finally {
            synchronized(lock) { inFlight-- }
        }
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    private fun settled(ids: Vault.BegunIds?, landed: String?, tracked: Boolean) {
        ids ?: return
        synchronized(lock) {
            keep { current ->
                var nodes = current.nodeIds
                if (tracked && landed != null && landed != ids.nodeId) nodes = nodes - ids.nodeId + landed
                current.copy(uploadIds = current.uploadIds - ids.uploadId, nodeIds = nodes)
            }
        }
    }

    private fun stop(reason: SaveRunStopped.Reason, message: String): SaveRunStopped = synchronized(lock) {
        stopped?.let { return it }
        // Marked first: what lands meanwhile is removed as it lands.
        stopped = SaveRunStopped(reason, message, SaveCleanup.NOTHING)
        val held = row
        for (uploadId in held.uploadIds) runCatching { writer.abortUpload(uploadId, held.workspaceId) }
        val cleanup = SaveRuns.discard(held.nodeIds, held.workspaceId, writer)
        if (cleanup != SaveCleanup.LEFT) journal.remove(held.id)
        SaveRunStopped(reason, message, cleanup).also { stopped = it }
    }

    /* Every result is in: the row goes. Refused while one is still on its way. */
    fun finish() {
        stopped?.let { throw it }
        synchronized(lock) {
            if (inFlight > 0) throw SaveRunStopped(SaveRunStopped.Reason.FAILED, "Some results are still being saved.", SaveCleanup.NOTHING)
            finished = true
            journal.remove(row.id)
        }
    }

    /* Stops the run and removes what it made (the caller cancels the work saving a result; one that lands afterwards goes as it lands). */
    fun cancel(): SaveCleanup {
        synchronized(lock) { if (finished) return SaveCleanup.NOTHING }
        return stop(SaveRunStopped.Reason.CANCELLED, SaveRuns.CANCELLED).cleanup
    }

    /* Results on their way: the app asks before it lets a run's screen go. */
    fun waiting(): Int = synchronized(lock) { inFlight }
}

/* The vault as a run's drive. */
class VaultSaveWriter(private val vault: Vault, private val storage: () -> StorageAllowance) : SaveRunWriter {
    override fun refusal(target: Opened, copy: Prior?): String? {
        val ws = target.node.workspaceId
        return try {
            // A copy into a family folder isn't offered (Vault.uploadInside): refused here, before anything is made.
            if (copy != null) vault.refuseFamilyWrite(ws) else vault.familyTarget(ws)
            null
        } catch (error: Exception) {
            if (FamilyUploads.waits(error, false)) null else error.message ?: FamilyWords.UNAVAILABLE
        }
    }

    /* Known for the account's own Drive, and for a family folder whose family's pool the figures are; never for a share. */
    override fun freeSpace(workspaceId: String): Long? {
        val figures = storage()
        if (workspaceId.equals(vault.workspaceId, ignoreCase = true)) return figures.free
        val family = vault.familyOf(workspaceId) ?: return null
        return if (figures.pool?.groupId.equals(family, ignoreCase = true)) figures.free else null
    }

    override fun names(folder: Opened): List<String> = buildList {
        var after: String? = null
        do {
            val page = vault.api.children(folder.id, folder.node.workspaceId, after)
            for (child in page.children) runCatching { vault.open(child) }.getOrNull()?.let { add(it.name) }
            after = page.nextCursor
        } while (after != null)
    }

    override fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened = vault.createFolder(folder.id, name, copy)

    override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                              onBegun: (Vault.BegunIds) -> Unit): Opened =
        vault.uploadResult(bytes, name, mime, folder.id, replacing, startedFrom, copy, onBegun = onBegun)

    override fun abortUpload(uploadId: String, workspaceId: String) { vault.api.abortUpload(uploadId, workspaceId) }

    override fun trash(ids: List<String>, workspaceId: String) {
        for (batch in ids.chunked(MAX_TRASH_BATCH)) vault.api.trashBatch(workspaceId, batch)
    }

    override fun purge(ids: List<String>, workspaceId: String) {
        for (id in ids) try {
            vault.api.purge(id, workspaceId)
        } catch (error: ApiError) {
            if (error.status != 404) throw error
        }
    }

    override fun mayPurge(workspaceId: String): Boolean =
        workspaceId.equals(vault.workspaceId, ignoreCase = true) || vault.isFamilyWorkspace(workspaceId)

    companion object {
        const val MAX_TRASH_BATCH = 200
    }
}
