package com.hushos.app.data

import com.hushos.core.NodeMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/*
 * The save path's one rule, checked by breaking it everywhere (the web's save-runs.faults.test.ts, iOS's
 * SaveRunFaultTests): a run is driven against a drive that records everything it publishes and every reservation, and
 * each of the run's waits (a listing, a folder's creation, a begin, a part, a completion, a journal write, an abort, a
 * trash, a purge) is made to fail in turn: no network, an answer lost after the server acted, a refusal, a full disk, or
 * the process dying there. After each:
 *
 * - everything the drive published is named by a row that survived (itself or a folder above it), or counted in what the
 *   run said it kept, or said to be what may remain;
 * - nothing the journal offers at the next launch is a save that finished;
 * - the next launch, from the journal alone, removes everything of a run that did not finish, and aborts every
 *   reservation the journal knew of.
 *
 * A new wait is covered by adding it to `Point`. Process death is everything failing from that point: nothing more
 * reaches the drive or the disk.
 */
class SaveRunFaultTest {
    enum class Point(val faults: List<Fault>) {
        LISTING(listOf(Fault.NETWORK, Fault.REFUSED, Fault.DEATH)),
        FOLDER(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
        BEGIN(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
        PART(listOf(Fault.NETWORK, Fault.DEATH)),
        COMPLETE(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
        JOURNAL(listOf(Fault.REFUSED, Fault.FULL, Fault.DEATH)),
        ABORT(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
        TRASH(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
        PURGE(listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH)),
    }

    enum class Fault { NETWORK, LOST, REFUSED, FULL, DEATH }

    data class Plan(val point: Point, val k: Int, val fault: Fault)

    /* What the drive holds and what the process may do, under one lock (the run's results go up on several threads). */
    class World(private val plan: Plan?) {
        private val lock = Any()
        private val counts = HashMap<Point, Int>()
        @Volatile var dead = false
            private set
        private var full = false

        data class Node(var state: String, val parent: String)
        data class Upload(var status: String, val nodeId: String, val version: Boolean, val parent: String)
        private val nodes = HashMap<String, Node>()
        private val uploads = HashMap<String, Upload>()
        val lostBegins = HashSet<String>()
        val recorded = HashSet<String>()
        private var next = 0

        fun fault(point: Point): Fault? = synchronized(lock) {
            val k = (counts[point] ?: 0) + 1
            counts[point] = k
            if (plan == null || plan.point != point || plan.k != k) return null
            if (plan.fault == Fault.DEATH) dead = true
            if (plan.fault == Fault.FULL) full = true
            plan.fault
        }
        val reached: Map<Point, Int> get() = synchronized(lock) { HashMap(counts) }

        /* The journal's hook: a write the disk refuses, or one a dead process never makes. */
        fun journalWrite(rows: List<SaveRunRow>) {
            val fault = fault(Point.JOURNAL)
            synchronized(lock) {
                if (dead || full || fault == Fault.REFUSED) throw java.io.IOException("No space left on device")
                for (row in rows) recorded += row.uploadIds
            }
        }

        fun begin(nodeId: String, version: Boolean, parent: String) = synchronized(lock) {
            val id = "up-${++next}"
            uploads[id] = Upload("open", nodeId, version, parent)
            id
        }
        fun lostBegin(id: String) = synchronized(lock) { lostBegins += id }
        fun complete(uploadId: String): String = synchronized(lock) {
            val upload = uploads[uploadId]
            if (upload == null || upload.status != "open") throw ApiError(404, "gone")
            upload.status = "completed"
            if (!upload.version) nodes[upload.nodeId] = Node("live", upload.parent)
            upload.nodeId
        }
        fun abort(uploadId: String): SaveAbortFate = synchronized(lock) {
            val upload = uploads[uploadId] ?: return SaveAbortFate.GONE
            if (upload.status == "completed") return SaveAbortFate.FINISHED
            upload.status = "aborted"
            SaveAbortFate.ABORTED
        }
        fun create(id: String, parent: String) = synchronized(lock) { nodes[id] = Node("live", parent) }
        fun names(parent: String) = synchronized(lock) { nodes.filter { it.value.parent == parent && it.value.state == "live" }.keys.toList() }
        fun trash(ids: List<String>) = synchronized(lock) {
            ids.associateWith { id ->
                val node = nodes[id]
                if (node != null && node.state != "purged") { node.state = "trash"; SaveItemFate.DONE } else SaveItemFate.GONE
            }
        }
        fun purge(ids: List<String>) = synchronized(lock) {
            ids.associateWith { id ->
                val node = nodes[id]
                if (node?.state == "trash") { node.state = "purged"; SaveItemFate.DONE } else SaveItemFate.GONE
            }
        }
        /* A folder deleted forever takes everything inside it. */
        private fun gone(id: String): Boolean {
            val node = nodes[id] ?: return true
            if (node.state == "purged") return true
            return if (nodes.containsKey(node.parent)) gone(node.parent) else false
        }
        val published: List<String> get() = synchronized(lock) { nodes.keys.filter { !gone(it) }.sorted() }
        fun lineage(id: String): List<String> = synchronized(lock) { generateSequence(id) { nodes[it]?.parent }.toList() }
        val versions: Int get() = synchronized(lock) { uploads.values.count { it.version && it.status == "completed" } }
        val openReservations: List<String> get() = synchronized(lock) { uploads.filter { it.value.status == "open" }.keys.toList() }
    }

    /* The drive one process sees: its calls fail as planned; `healthy` is the next launch's working one. */
    class FaultyDrive(private val world: World, private val healthy: Boolean) : SaveRunWriter {
        private fun <T> call(point: Point, effect: () -> T, refused: () -> T): T {
            val fault = if (healthy) null else world.fault(point)
            if (!healthy && (world.dead || fault == Fault.NETWORK)) throw Unreachable()
            if (fault == Fault.REFUSED) return refused()
            val result = effect()
            if (fault == Fault.LOST) {
                if (point == Point.BEGIN) world.lostBegin(result as String)
                throw Unreachable()
            }
            return result
        }
        private fun <T> refuse(): T = throw ApiError(400, "Refused.")
        private fun opened(id: String, parent: String, kind: String = "file") =
            Opened(NodeView(id, "ws", parent, kind, 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))

        override fun refusal(target: Opened): String? = null
        override fun room(workspaceId: String): SaveRoom = SaveRoom.Own(1L shl 40)
        override fun names(folder: Opened): List<String> = call(Point.LISTING, { world.names(folder.id) }, ::refuse)
        override fun makeFolder(folder: Opened, name: String, copy: Prior?, minted: (String) -> Unit): Opened {
            val id = "folder-${UUID.randomUUID().toString().take(8)}"
            minted(id)
            call(Point.FOLDER, { world.create(id, folder.id) }, ::refuse)
            return opened(id, folder.id, "folder")
        }
        override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                                  thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit, onCompleting: (String) -> Unit): Opened {
            val nodeId = replacing?.id ?: "node-${UUID.randomUUID().toString().take(8)}"
            val uploadId = call(Point.BEGIN, { world.begin(nodeId, replacing != null, folder.id) }, ::refuse)
            // As the vault does: a begin its run can't record, a part that fails, a completion its run refuses, abort.
            try {
                onBegun(Vault.BegunIds("ws", uploadId, nodeId))
                repeat(2) { call(Point.PART, {}, ::refuse) }
                onCompleting(uploadId)
            } catch (error: Exception) {
                abortUpload(uploadId, "ws")
                throw error
            }
            return opened(call(Point.COMPLETE, { world.complete(uploadId) }, ::refuse), folder.id)
        }
        override fun fresh(file: Opened, folder: Opened): Opened? = file
        override fun refreshFolder(folder: Opened): Opened = folder
        override fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate =
            runCatching { call(Point.ABORT, { world.abort(uploadId) }, { SaveAbortFate.DENIED }) }.getOrDefault(SaveAbortFate.UNKNOWN)
        override fun trash(ids: List<String>, workspaceId: String) = call(Point.TRASH, { world.trash(ids) }, { ids.associateWith { SaveItemFate.REFUSED } })
        override fun purge(ids: List<String>, workspaceId: String) = call(Point.PURGE, { world.purge(ids) }, { ids.associateWith { SaveItemFate.REFUSED } })
        override fun mayPurge(workspaceId: String) = true
    }

    private val own = SaveSources.OwnWriting
    private fun node(id: String, parent: String?, version: String? = null): Opened {
        val current = version?.let { VersionView(it, "o", "", "ready", 3u, 1, "n", null, null, null) }
        return Opened(NodeView(id, "ws", parent, if (version == null) "folder" else "file", 1uL, 1uL, "", 1uL, "", current, null, null, null),
            NodeMetadata(id, null, null, null, emptyMap()))
    }
    private val f = node("f", "root")
    private val doc = node("doc", "f", "v1")
    private val pool = Executors.newFixedThreadPool(4)

    /* Results saved at once, as a tool hands them in from its own threads. */
    private fun together(vararg work: () -> Unit) {
        val futures = work.map { pool.submit(Callable { it() }) }
        var first: Throwable? = null
        for (future in futures) runCatching { future.get() }.onFailure { first = first ?: (it.cause ?: it) }
        first?.let { throw it }
    }

    /* Representative runs: several new files, a folder tree, a new version, and a mix. */
    private val scenarios: List<Pair<String, (SaveRun) -> Unit>> = listOf(
        "several new files" to { run -> together({ run.file(byteArrayOf(1), "a", null, own) }, { run.file(byteArrayOf(1), "b", null, own) }, { run.file(byteArrayOf(1), "c", null, own) }) },
        "a folder tree" to { run ->
            val out = run.folder("Out", own)
            val inner = run.folder("Inner", own, out)
            run.file(byteArrayOf(1), "a", null, own, folder = inner)
            run.file(byteArrayOf(1), "b", null, own, folder = out)
        },
        "a new version" to { run -> run.version(byteArrayOf(1), doc, f, "v1", own) },
        "a mix" to { run ->
            val out = run.folder("Out", own)
            together({ run.version(byteArrayOf(1), doc, f, "v1", own) }, { run.file(byteArrayOf(1), "a", null, own) }, { run.file(byteArrayOf(1), "b", null, own, folder = out) })
        },
    )

    sealed class Outcome {
        object Finished : Outcome()
        object NotStarted : Outcome()
        object Unrecorded : Outcome()
        class Stopped(val stopped: SaveRunStopped) : Outcome()
    }

    class Played(val world: World, val file: java.io.File, val session: SaveRunJournal.Epoch, val outcome: Outcome, val escaped: List<String>)

    private fun play(scenario: (SaveRun) -> Unit, plan: Plan?): Played {
        val world = World(plan)
        val file = Files.createTempDirectory("save-faults").resolve(SaveRunJournal.FILE).toFile()
        val session = SaveRunJournal.Epoch()
        val rows = SaveRunJournal(file, session).apply { fault = { written -> world.journalWrite(written) } }
        val drive = FaultyDrive(world, healthy = false)
        val escaped = ArrayList<String>()
        val run = try {
            SaveRun.start(drive, listOf(f, doc), emptyList(), rows, pause = {})
        } catch (_: Exception) {
            return Played(world, file, session, Outcome.NotStarted, escaped)
        }
        val outcome = try {
            scenario(run)
            run.finish()
            Outcome.Finished
        } catch (stopped: SaveRunStopped) {
            Outcome.Stopped(stopped)
        } catch (_: SaveRecordNotUpdated) {
            Outcome.Unrecorded
        } catch (error: Exception) {
            // A failure that never went through the run's stop: the rule broken.
            escaped += error.toString()
            Outcome.Stopped(run.cancel())
        }
        return Played(world, file, session, outcome, escaped)
    }

    /* The invariant, as violations (empty when it holds). */
    private fun violations(scenario: (SaveRun) -> Unit, plan: Plan?): List<String> {
        val played = play(scenario, plan)
        val world = played.world
        val found = played.escaped.map { "a failure escaped the run's stop: $it" }.toMutableList()
        // The next launch: the same file, a new journal on it, a working drive.
        val disk = SaveRunJournal(played.file, played.session)
        val rows = disk.list()
        val named = rows.flatMap { it.nodeIds }.toSet()
        val dead = world.dead
        val outcome = played.outcome
        val mayRemain = outcome is Outcome.Stopped && !dead && outcome.stopped.message?.contains("may still be there") == true
        if (outcome is Outcome.Stopped && !dead) {
            val said = outcome.stopped.keptVersions + outcome.stopped.uncertainVersions
            if (world.versions > said) found += "${world.versions} versions published, $said said"
        }
        val offered = rows.filter { !it.done }
        if (outcome is Outcome.Finished && !dead) {
            if (offered.isNotEmpty()) found += "a finished save is offered for deletion"
        } else {
            for (id in world.published) if (world.lineage(id).none { it in named } && !mayRemain) found += "$id is published, named by no row, and not said to remain"
            val healthy = FaultyDrive(world, healthy = true)
            for (row in offered) SaveRuns.cleanUp(row, healthy, disk)
            if (!mayRemain) for (id in world.published) found += "$id is still there after the next launch's clean-up"
            if (disk.list().any { !it.done }) found += "a row survived the next launch's clean-up"
            // A reservation no row ever named is the server's expiry's: nothing is completed before its row is on disk.
            val known = world.openReservations.filter { it in world.recorded && it !in world.lostBegins }
            if (known.isNotEmpty()) found += "reservations left open: ${known.sorted()}"
        }
        return found
    }

    @Test
    fun whateverFailsNothingPublishedIsUnaccountedForAndNothingSavedIsOffered() {
        val failures = ArrayList<String>()
        var tried = 0
        for ((name, scenario) in scenarios) {
            // A clean run first: how often it reaches each wait, so each one is failed in turn.
            val clean = play(scenario, null)
            assertTrue("$name: a clean run didn't finish", clean.outcome is Outcome.Finished)
            val counts = HashMap(clean.world.reached)
            // The clean-up's waits are only reached once something fails: tried a few times each.
            for (point in listOf(Point.ABORT, Point.TRASH, Point.PURGE)) counts[point] = maxOf(counts[point] ?: 0, 3)
            counts[Point.JOURNAL] = (counts[Point.JOURNAL] ?: 0) + 2
            for (point in Point.values()) for (k in 1..maxOf(1, counts[point] ?: 0)) for (fault in point.faults) {
                tried++
                for (found in violations(scenario, Plan(point, k, fault))) failures += "$name: ${point.name.lowercase()} #$k ${fault.name.lowercase()}: $found"
            }
        }
        assertTrue(tried > 80)
        assertEquals(emptyList<String>(), failures)
        pool.shutdown()
    }
}
