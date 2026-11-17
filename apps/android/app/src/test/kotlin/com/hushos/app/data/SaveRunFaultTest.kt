package com.hushos.app.data

import com.hushos.core.NodeMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.UUID
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
        LISTING(listOf(Fault.NETWORK, Fault.REFUSED, Fault.DEATH, Fault.OUTAGE) + PEOPLE),
        FOLDER(SERVER),
        BEGIN(SERVER),
        PART(listOf(Fault.NETWORK, Fault.DEATH, Fault.OUTAGE) + PEOPLE),
        COMPLETE(SERVER),
        JOURNAL(listOf(Fault.REFUSED, Fault.FULL, Fault.DEATH, Fault.CRASH) + PEOPLE),
        ABORT(SERVER),
        TRASH(SERVER),
        PURGE(SERVER),
    }

    /*
     * CRASH: the drive (or the disk) acts, then the process dies before hearing. OUTAGE: the network goes for good while
     * the process lives on. CANCEL, SIGNOUT, LOCK: the person cancels, signs out (the journal goes with the account), or the
     * device locks (every later call refused) just as that wait is reached.
     */
    enum class Fault { NETWORK, LOST, REFUSED, FULL, DEATH, CRASH, OUTAGE, CANCEL, SIGNOUT, LOCK }

    companion object {
        val PEOPLE = listOf(Fault.CANCEL, Fault.SIGNOUT, Fault.LOCK)
        val SERVER = listOf(Fault.NETWORK, Fault.LOST, Fault.REFUSED, Fault.DEATH, Fault.CRASH, Fault.OUTAGE) + PEOPLE
    }

    /* The device locked: the vault's keys are gone, and every later call is refused. */
    class VaultLocked : Exception("This device locked.")

    data class Plan(val point: Point, val k: Int, val fault: Fault)

    /* What the drive holds and what the process may do, under one lock (the run's results go up on several threads). */
    class World(private val plan: Plan?) {
        private val lock = Any()
        private val counts = HashMap<Point, Int>()
        @Volatile var dead = false
            private set
        private var full = false
        @Volatile var outage = false
            private set
        @Volatile var locked = false
            private set
        @Volatile var signedOut = false
        @Volatile var interrupt: ((Fault) -> Unit)? = null
        fun die() { dead = true }
        /* After a fault is counted, outside the lock: the person's own act. */
        fun act(fault: Fault?) { if (fault in PEOPLE) interrupt?.invoke(fault!!) }

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
            if (plan.fault == Fault.OUTAGE) outage = true
            if (plan.fault == Fault.LOCK) locked = true
            plan.fault
        }
        val reached: Map<Point, Int> get() = synchronized(lock) { HashMap(counts) }

        /* The journal's hook: a write the disk refuses, or one a dead process never makes. */
        fun journalWrite(rows: List<SaveRunRow>) {
            val fault = fault(Point.JOURNAL)
            act(fault)
            synchronized(lock) {
                if (dead || full || fault == Fault.REFUSED) throw java.io.IOException("No space left on device")
                for (row in rows) recorded += row.uploadIds
                // This write lands; the process is gone before it hears so.
                if (fault == Fault.CRASH) dead = true
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
        /* How many items folder `id` holds, or null when it isn't there. */
        fun holds(id: String): Int? = synchronized(lock) { if (gone(id)) null else nodes.values.count { it.parent == id } }
        fun lineage(id: String): List<String> = synchronized(lock) { generateSequence(id) { nodes[it]?.parent }.toList() }
        val versions: Int get() = synchronized(lock) { uploads.values.count { it.version && it.status == "completed" } }
        val openReservations: List<String> get() = synchronized(lock) { uploads.filter { it.value.status == "open" }.keys.toList() }
    }

    /* The drive one process sees: its calls fail as planned; `healthy` is the next launch's working one. */
    class FaultyDrive(private val world: World, private val healthy: Boolean) : SaveRunWriter {
        private fun <T> call(point: Point, effect: () -> T, refused: () -> T): T {
            val fault = if (healthy) null else world.fault(point)
            if (!healthy) world.act(fault)
            if (!healthy && (world.dead || world.outage || fault == Fault.NETWORK)) throw Unreachable()
            if (!healthy && world.locked) throw VaultLocked()
            if (fault == Fault.REFUSED) return refused()
            val result = effect()
            if (fault == Fault.LOST || fault == Fault.CRASH) {
                if (fault == Fault.CRASH) world.die()
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
        override fun lookFolder(id: String, workspaceId: String): Int? = call(Point.LISTING, { world.holds(id) }, ::refuse)
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

    /*
     * Results handed in one after another, on a thread of their own each but never two at once: the k-th begin is the
     * same one every time, so a failure replays (concurrent results are SaveRunTest's).
     */
    private fun <T> together(vararg work: () -> T): List<T> = work.map { it() }

    /* What a run was given: its new files and folders, and how many new versions were saved. */
    data class Made(val nodes: List<String> = emptyList(), val versions: Int = 0)
    private fun saved(result: VersionSaved) = if (result is VersionSaved.Saved) 1 else 0

    /* Representative runs: several new files, a folder tree, a new version, and a mix. */
    private val scenarios: List<Pair<String, (SaveRun) -> Made>> = listOf(
        "several new files" to { run ->
            Made(together({ run.file(byteArrayOf(1), "a", null, own) }, { run.file(byteArrayOf(1), "b", null, own) }, { run.file(byteArrayOf(1), "c", null, own) }).map { it.id })
        },
        "a folder tree" to { run ->
            val out = run.folder("Out", own)
            val inner = run.folder("Inner", own, out)
            val a = run.file(byteArrayOf(1), "a", null, own, folder = inner)
            val b = run.file(byteArrayOf(1), "b", null, own, folder = out)
            Made(listOf(out.id, inner.id, a.id, b.id))
        },
        "a new version" to { run -> Made(versions = saved(run.version(byteArrayOf(1), doc, f, "v1", own))) },
        "a mix" to { run ->
            val out = run.folder("Out", own)
            val version = together({ saved(run.version(byteArrayOf(1), doc, f, "v1", own)) }).single()
            val files = together({ run.file(byteArrayOf(1), "a", null, own) }, { run.file(byteArrayOf(1), "b", null, own, folder = out) })
            Made(listOf(out.id) + files.map { it.id }, version)
        },
    )

    sealed class Outcome {
        class Finished(val made: Made) : Outcome()
        object NotStarted : Outcome()
        object Unrecorded : Outcome()
        class Stopped(val stopped: SaveRunStopped) : Outcome()
    }

    class Played(val world: World, val file: java.io.File, val session: SaveRunJournal.Epoch, val outcome: Outcome, val escaped: List<String>)

    private fun play(scenario: (SaveRun) -> Made, plan: Plan?): Played {
        val world = World(plan)
        val file = Files.createTempDirectory("save-faults").resolve(SaveRunJournal.FILE).toFile()
        val session = SaveRunJournal.Epoch()
        val rows = SaveRunJournal(file, session).apply { fault = { written -> world.journalWrite(written) } }
        val drive = FaultyDrive(world, healthy = false)
        val escaped = ArrayList<String>()
        var started: SaveRun? = null
        world.interrupt = { fault ->
            when (fault) {
                Fault.CANCEL -> started?.let { run -> pool.submit { run.cancel() } }
                // As AccountStore.wipe does, on this journal's own session: runs abandoned, the journal gone.
                Fault.SIGNOUT -> { world.signedOut = true; SaveRuns.abandonAll(session); session.end(); file.delete() }
                else -> Unit
            }
        }
        val run = try {
            SaveRun.start(drive, listOf(f, doc), emptyList(), rows, pause = {}).also { started = it }
        } catch (_: Exception) {
            return Played(world, file, session, Outcome.NotStarted, escaped)
        }
        val outcome = try {
            val made = scenario(run)
            run.finish()
            Outcome.Finished(made)
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
    private fun violations(scenario: (SaveRun) -> Made, plan: Plan?): List<String> {
        val played = play(scenario, plan)
        val world = played.world
        val found = played.escaped.map { "a failure escaped the run's stop: $it" }.toMutableList()
        // The next launch: the same file, a new journal on it, a working drive.
        val disk = SaveRunJournal(played.file, played.session)
        val rows = disk.list()
        val named = rows.flatMap { it.nodeIds }.toSet()
        val dead = world.dead
        val signedOut = world.signedOut
        val outcome = played.outcome
        val message = if (outcome is Outcome.Stopped && !dead) outcome.stopped.message.orEmpty() else null
        // "You'll be asked about it next time" promises a row; only "can no longer remove it", and a sign-out's "may still be
        // there", excuse an unnamed node.
        val excused = message != null && ("can no longer remove it" in message || (signedOut && "may still be there" in message))
        if (outcome is Outcome.Stopped && message != null) {
            val stopped = outcome.stopped
            val said = stopped.keptVersions + stopped.uncertainVersions
            if (world.versions > said) found += "${world.versions} versions published, $said said"
            // Never claiming more than is so.
            if ("Nothing was saved" in message && (world.published.isNotEmpty() || world.versions > 0))
                found += "says nothing was saved: ${world.published.size} there, ${world.versions} versions"
            if ("Nothing else was saved" in message && world.published.isNotEmpty()) found += "says nothing else was saved: ${world.published} there"
            if (stopped.keptVersions > world.versions) found += "says ${stopped.keptVersions} versions kept, ${world.versions} exist"
        }
        val offered = rows.filter { !it.done }
        if (outcome is Outcome.Finished && offered.isEmpty()) {
            for (id in outcome.made.nodes) if (id !in world.published) found += "a saved result $id isn't there"
            if (world.versions < outcome.made.versions) found += "a saved version isn't there"
        } else if (signedOut) {
            // The journal went with the account: only what it said may remain may be there.
            if (!dead && !excused) for (id in world.published) found += "$id is there after a sign-out that didn't say so"
        } else {
            for (id in world.published) if (world.lineage(id).none { it in named } && !excused) found += "$id is published, named by no row"
            val healthy = FaultyDrive(world, healthy = true)
            for (row in offered) SaveRuns.cleanUp(row, healthy, disk)
            if (!excused) for (id in world.published) found += "$id is still there after the next launch's clean-up"
            // Only a folder whose creation may still land keeps its row past that launch; once the creation window has
            // passed, the launch after settles it.
            for (row in disk.list().filter { !it.done }) if (row.uploadIds.isNotEmpty() || !row.nodeIds.all { it in row.uncertain })
                found += "a row survived the next launch's clean-up"
            val later = System.currentTimeMillis() + SaveRuns.CREATION_SETTLE_MS
            for (row in disk.list().filter { !it.done }) SaveRuns.cleanUp(row, healthy, disk, now = later)
            if (disk.list().any { !it.done }) found += "a row survived past the creation window"
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
