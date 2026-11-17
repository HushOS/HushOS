package com.hushos.app.data

import android.content.Context
import com.hushos.core.deviceRemember
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.Executors

/*
 * The save path's rule one level down (SaveRunFaultTest drives a stand-in drive): the real SaveRun over the real Vault
 * (VaultSaveWriter: its uploads from memory, folder creations, listings, aborts, trash and purge) against FakeDrive, the
 * fake server every vault test uses, which answers as packages/db does where it matters here: a begin at a key epoch the
 * file no longer has is `stale`, a completion that finds the file moved is `conflicted` naming the version current now, an
 * abort of a finished upload says so in `data.upload`. Trash and purge are served here per item (trash-batch, delete).
 *
 * Each wait (the room check, a listing, the epoch allocation, a folder's creation, a begin, a part, a completion, an abort,
 * a trash, a purge, a journal write) is failed in turn at its first reach and at one more drawn with a fixed seed, with
 * no network, a lost answer, a refusal, an outage, a cancel, a crash just after the server acted, or the process dying.
 * After each: everything the run published is named by a surviving row or said to remain, nothing a finished save made
 * is offered for deletion, a finished save's results are all there under names no other child of their folder has, and
 * `stale` means a real race.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SaveRunEngineTest {
    enum class Point { ROOM, LISTING, ALLOCATE, FOLDER, BEGIN, PART, COMPLETE, ABORT, TRASH, PURGE, JOURNAL }
    enum class Fault { NETWORK, LOST, REFUSED, OUTAGE, CANCEL, CRASH, DEATH }
    data class Plan(val point: Point, val k: Int, val fault: Fault)

    private val asking = listOf(Fault.NETWORK, Fault.REFUSED, Fault.OUTAGE, Fault.CANCEL, Fault.DEATH)
    private val all = Fault.values().toList()
    private fun faultsOf(point: Point) = when (point) {
        Point.ROOM, Point.LISTING, Point.ALLOCATE -> asking
        Point.PART -> listOf(Fault.NETWORK, Fault.REFUSED, Fault.OUTAGE, Fault.CANCEL, Fault.DEATH)
        Point.JOURNAL -> listOf(Fault.REFUSED, Fault.CRASH, Fault.CANCEL, Fault.DEATH)
        else -> all
    }

    /* Which wait a request is. */
    private fun pointOf(method: String, path: String): Point? {
        val p = path.trim('/')
        return when {
            p.startsWith("store/") -> Point.PART
            method == "GET" && p.matches(Regex("drive/nodes/[^/]+/children")) -> Point.LISTING
            method == "POST" && p.matches(Regex("drive/workspaces/[^/]+/epochs")) -> Point.ALLOCATE
            method == "POST" && p == "drive/folders" -> Point.FOLDER
            method == "POST" && p == "drive/uploads" -> Point.BEGIN
            method == "POST" && p.matches(Regex("drive/uploads/[^/]+/complete")) -> Point.COMPLETE
            method == "POST" && p.matches(Regex("drive/uploads/[^/]+/abort")) -> Point.ABORT
            method == "POST" && p.matches(Regex("drive/workspaces/[^/]+/trash-batch")) -> Point.TRASH
            method == "DELETE" && p.matches(Regex("drive/nodes/[^/]+")) -> Point.PURGE
            else -> null
        }
    }

    /* The faults as the process meets them; `live` false for the next launch (a working network). */
    class World(private val plan: Plan?) {
        private val counts = HashMap<Point, Int>()
        @Volatile var dead = false
        @Volatile var outage = false
        @Volatile var live = true
        @Volatile var interrupt: (() -> Unit)? = null
        val reached: Map<Point, Int> get() = synchronized(counts) { HashMap(counts) }
        fun fault(point: Point): Fault? {
            if (!live) return null
            val fault = synchronized(counts) {
                val k = (counts[point] ?: 0) + 1
                counts[point] = k
                if (plan == null || plan.point != point || plan.k != k) null else plan.fault
            }
            if (fault == Fault.DEATH) dead = true
            if (fault == Fault.OUTAGE) outage = true
            if (fault == Fault.CANCEL) interrupt?.invoke()
            return fault
        }
    }

    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val pool = Executors.newCachedThreadPool()

    /* A FakeDrive with `f` (a folder) and `doc` (a file) in its root, and a vault that listed both. */
    class Setup(val server: FakeDrive, val vault: Vault, val world: World, val f: Opened, val doc: Opened, val original: Set<String>, val docVersion: String)

    private fun setUp(plan: Plan?): Setup {
        val server = FakeDrive()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("save-engine-${UUID.randomUUID()}", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        val fId = server.folder(server.root, "f")
        val docId = server.file(fId, "doc.txt", "first".toByteArray())
        server.file(fId, "report.pdf", "r".toByteArray())
        val vault = Vault(context, DriveApi(Shared.session(context)!!))
        val f = vault.listChildren(server.root).single { it.id == fId }
        val doc = vault.listChildren(fId).single { it.id == docId }
        val world = World(plan)
        // Faults by route: no network (the connection dropped before the server acts), a lost answer (it acts, then
        // drops), a refusal. A dead process, or an outage, reaches nothing.
        val pending = HashMap<Thread, Fault>()
        // A part's fault is answered at once, from the store (a dropped PUT would leave the client writing its body until
        // its timeout): no network, an outage or a dead process as 503, a refusal as 403.
        val abortAsked = java.util.Collections.synchronizedSet(HashSet<String>())
        server.storeStatus = { method, path ->
            if (method != "PUT") null
            // A part for an upload already aborted: the store has nothing there.
            else if (abortAsked.any { path.contains("/parts/$it/") }) 404
            else {
                val fault = world.fault(Point.PART)
                when {
                    world.live && (world.dead || world.outage) -> 503
                    fault == Fault.NETWORK -> 503
                    fault == Fault.REFUSED -> 403
                    else -> null
                }
            }
        }
        // A request that never reaches the server is still read whole (a connection dropped before its body is read
        // leaves the client writing it until its timeout): the fake answers nothing in its place and drops the reply.
        val unreached = java.util.Collections.synchronizedSet(HashSet<Thread>())
        server.beforeAnswer = hook@{ method, path ->
            if (path.trimStart('/').startsWith("store/")) return@hook
            val point = pointOf(method, path)
            if (point == Point.ABORT) abortAsked += path.trim('/').split("/")[2]
            val fault = if (world.live && (world.dead || world.outage)) null else point?.let(world::fault)
            if (fault == Fault.NETWORK || (world.live && (world.dead || world.outage))) unreached += Thread.currentThread() else unreached -= Thread.currentThread()
            synchronized(pending) { if (fault != null) pending[Thread.currentThread()] = fault else pending.remove(Thread.currentThread()) }
        }
        server.dropReply = { _, _ ->
            val fault = synchronized(pending) { pending.remove(Thread.currentThread()) }
            if (fault == Fault.CRASH) world.dead = true
            unreached.remove(Thread.currentThread()) || fault == Fault.LOST || fault == Fault.CRASH
        }
        server.extraRoutes = { method, segments, _, body ->
            val fault = synchronized(pending) { pending[Thread.currentThread()] }
            when {
                Thread.currentThread() in unreached -> 503 to JSONObject()
                fault == Fault.REFUSED -> { synchronized(pending) { pending.remove(Thread.currentThread()) }; 403 to JSONObject().put("code", "forbidden").put("message", "Refused.") }
                // Trash and delete forever, per item, as the batch routes answer.
                method == "POST" && segments.size == 4 && segments[3] == "trash-batch" -> {
                    val ids = body.getJSONArray("nodeIds")
                    200 to JSONObject().put("results", JSONArray((0 until ids.length()).map { i ->
                        val id = ids.getString(i)
                        if (runCatching { server.node(id) }.isSuccess) { server.trash(id); JSONObject().put("id", id).put("status", "trashed") }
                        else JSONObject().put("id", id).put("status", "refused").put("reason", "not-found")
                    }))
                }
                method == "DELETE" && segments.size == 3 && segments[1] == "nodes" ->
                    if (runCatching { server.node(segments[2]) }.isSuccess) { server.purgeAs(segments[2]); 200 to JSONObject() }
                    else 404 to JSONObject().put("code", "not-found").put("message", "This item no longer exists.")
                else -> null
            }
        }
        return Setup(server, vault, world, f, doc, server.children(fId).map { it.id }.toSet() + fId + server.root, doc.node.currentVersion!!.id)
    }

    /* What a run was given: its new files and folders, and its new versions saved or stale. */
    data class Made(val nodes: List<String> = emptyList(), val saved: Int = 0, val stale: List<String?> = emptyList())

    private val own = SaveSources.OwnWriting
    private fun versionOf(run: SaveRun, s: Setup): Made = when (val result = run.version("new".toByteArray(), s.doc, s.f, s.docVersion, own)) {
        is VersionSaved.Saved -> Made(saved = 1)
        is VersionSaved.Stale -> Made(stale = listOf(result.currentVersionId))
    }

    private class Scenario(val before: (Setup) -> Unit = {}, val run: (SaveRun, Setup) -> Made)

    private val scenarios: Map<String, Scenario> = linkedMapOf(
        "new files" to Scenario { run, s -> Made(listOf(run.file("a".toByteArray(), "a.txt", "text/plain", own, folder = s.f).id, run.file("b".toByteArray(), "b.txt", "text/plain", own, folder = s.f).id)) },
        "a folder tree" to Scenario { run, s ->
            val out = run.folder("Out", own, s.f)
            Made(listOf(out.id, run.file("a".toByteArray(), "a.txt", "text/plain", own, folder = out).id))
        },
        "a new version" to Scenario { run, s -> versionOf(run, s) },
        // Another device renamed a child this phone listed before: a result never takes that child's new name.
        "a child renamed elsewhere" to Scenario(before = { s -> s.server.renameAs(s.server.child(s.f.id, "report.pdf").id, "summary.pdf") }) { run, s ->
            Made(listOf(run.file("s".toByteArray(), "summary.pdf", "application/pdf", own, folder = s.f).id))
        },
        // A key change re-keyed the file while the version went up (its version the same): sealed afresh, never stale.
        "a key change, the version the same" to Scenario(before = { s ->
            var once = true
            val served = s.server.extraRoutes
            s.server.extraRoutes = { method, segments, query, body ->
                if (once && method == "POST" && segments.size == 4 && segments[1] == "uploads" && segments[3] == "complete") {
                    once = false
                    409 to JSONObject().put("code", "conflict").put("message", "This file changed while it was uploading.")
                        .put("data", JSONObject().put("conflicted", true).put("currentVersionId", s.docVersion))
                } else served?.invoke(method, segments, query, body)
            }
        }) { run, s -> versionOf(run, s) },
    )

    sealed class Outcome {
        class Finished(val made: Made) : Outcome()
        object NotStarted : Outcome()
        object Unrecorded : Outcome()
        class Stopped(val stopped: SaveRunStopped) : Outcome()
    }

    private fun play(name: String, plan: Plan?): Pair<Setup, List<String>> {
        val began = System.nanoTime()
        try { return playTimed(name, plan) } finally { if (System.getenv("SAVE_ENGINE_TIMING") != null) println("play $name $plan ${(System.nanoTime() - began) / 1_000_000} ms") }
    }

    private fun playTimed(name: String, plan: Plan?): Pair<Setup, List<String>> {
        val s = setUp(plan)
        val scenario = scenarios.getValue(name)
        scenario.before(s)
        val file = Files.createTempDirectory("save-engine").resolve(SaveRunJournal.FILE).toFile()
        val session = SaveRunJournal.Epoch()
        val recorded = HashSet<String>()
        val rows = SaveRunJournal(file, session).apply {
            fault = { written ->
                val fault = s.world.fault(Point.JOURNAL)
                if (s.world.dead || fault == Fault.REFUSED) throw java.io.IOException("No space left on device")
                for (row in written) recorded += row.uploadIds
                if (fault == Fault.CRASH) s.world.dead = true
            }
        }
        val writer = VaultSaveWriter(s.vault) {
            val fault = s.world.fault(Point.ROOM)
            if (s.world.dead || s.world.outage || fault == Fault.NETWORK) throw Unreachable()
            if (fault == Fault.REFUSED) throw ApiError(403, "Refused.")
            StorageAllowance(1L shl 40, 0L, 1L shl 40)
        }
        val found = ArrayList<String>()
        var started: SaveRun? = null
        s.world.interrupt = { started?.let { run -> pool.submit { run.cancel() } } }
        val outcome: Outcome = try {
            val run = SaveRun.start(writer, listOf(s.f, s.doc), emptyList(), rows, pause = {}).also { started = it }
            try {
                val made = scenario.run(run, s)
                run.finish()
                Outcome.Finished(made)
            } catch (stopped: SaveRunStopped) {
                Outcome.Stopped(stopped)
            } catch (_: SaveRecordNotUpdated) {
                Outcome.Unrecorded
            } catch (error: Exception) {
                found += "a failure escaped the run's stop: $error"
                Outcome.Stopped(run.cancel())
            }
        } catch (_: Exception) {
            Outcome.NotStarted
        }
        Thread.sleep(50)
        found += judge(s, file, session, recorded, outcome)
        // A part the store took after its upload was aborted is the fake's own lookup failing (the real store answers 404).
        runCatching { s.server.close() }.exceptionOrNull()?.let { error ->
            if (!(error.message.orEmpty() + error.cause?.message.orEmpty()).contains("is missing in the map")) found += "the fake server failed: $error"
        }
        return s to found
    }

    /* New files and folders the run made that are still there (live or in the Trash). */
    private fun published(s: Setup): List<String> {
        fun here(id: String): Boolean {
            val node = runCatching { s.server.node(id) }.getOrNull() ?: return false
            return node.parentId?.let { it == s.server.root || here(it) } ?: true
        }
        return s.server.children(s.f.id).map { it.id }.filter { it !in s.original } +
            s.server.children(s.f.id).filter { it.kind == "folder" && it.id !in s.original }.flatMap { folder -> s.server.children(folder.id).map { it.id } }
                .filter { here(it) }
    }
    private fun versions(s: Setup) = if (s.server.node(s.doc.id).version?.id != s.docVersion) 1 else 0
    private fun lineage(s: Setup, id: String) = generateSequence(id) { runCatching { s.server.node(it).parentId }.getOrNull() }.toList()

    private fun judge(s: Setup, file: java.io.File, session: SaveRunJournal.Epoch, recorded: Set<String>, outcome: Outcome): List<String> {
        val found = ArrayList<String>()
        val dead = s.world.dead
        s.world.live = false
        val disk = SaveRunJournal(file, session)
        val rows = disk.list()
        val named = rows.flatMap { it.nodeIds }.toSet()
        val published = published(s)
        val message = if (outcome is Outcome.Stopped && !dead) outcome.stopped.message.orEmpty() else null
        val excused = message != null && "can no longer remove it" in message
        if (outcome is Outcome.Stopped && message != null) {
            val stopped = outcome.stopped
            if ("Nothing was saved" in message && (published.isNotEmpty() || versions(s) > 0)) found += "says nothing was saved: ${published.size} there, ${versions(s)} versions"
            if (stopped.keptVersions > versions(s)) found += "says ${stopped.keptVersions} versions kept, ${versions(s)} exist"
            if (versions(s) > stopped.keptVersions + stopped.uncertainVersions) found += "${versions(s)} versions published, ${stopped.keptVersions + stopped.uncertainVersions} said"
        }
        val offered = rows.filter { !it.done }
        if (outcome is Outcome.Finished && offered.isEmpty()) {
            for (id in outcome.made.nodes) if (id !in published) found += "a saved result $id isn't there"
            if (versions(s) < outcome.made.saved) found += "a saved version isn't there"
            for (current in outcome.made.stale) if (s.server.node(s.doc.id).version?.id == s.docVersion) found += "said stale (naming $current), but nobody else saved"
            // No two children of a folder share a name: a result takes the next free one.
            val names = s.server.children(s.f.id).filter { it.trashedAt == null }.map { s.server.record(it.id).name.lowercase() }
            if (names.size != names.toSet().size) found += "two children of the folder share a name: ${names.sorted()}"
        } else {
            for (id in published) if (lineage(s, id).none { it in named } && !excused) found += "$id is published, named by no row${message?.let { " (said: $it)" } ?: ""}"
            // The next launch, from the journal alone, on a working network.
            val healthy = VaultSaveWriter(s.vault) { StorageAllowance(1L shl 40, 0L, 1L shl 40) }
            for (row in offered) SaveRuns.cleanUp(row, healthy, disk)
            if (!excused) for (id in published(s)) found += "$id is still there after the next launch's clean-up"
            if (disk.list().any { !it.done }) found += "a row survived the next launch's clean-up"
        }
        return found
    }

    // Retries don't wait: the faults here are on purpose, and the backoff would only make the run slow.
    @org.junit.Before
    fun noWaits() { Resumable.pause = {} }

    @org.junit.After
    fun waitsBack() { Resumable.pause = Thread::sleep }

    @Test
    fun theRuleHoldsOverTheRealVaultWhateverFails() {
        val failures = ArrayList<String>()
        var tried = 0
        val random = java.util.Random(7)
        for (name in scenarios.keys) {
            val (clean, cleanFound) = play(name, null)
            assertEquals("$name: a clean run", emptyList<String>(), cleanFound)
            val counts = clean.world.reached
            for (point in Point.values()) {
                val reached = maxOf(1, counts[point] ?: 0, if (point in listOf(Point.ABORT, Point.TRASH, Point.PURGE)) 3 else 0)
                val ks = (listOf(1) + if (reached > 1) listOf(2 + random.nextInt(reached - 1)) else emptyList()).distinct()
                for (k in ks) for (fault in faultsOf(point)) {
                    tried++
                    for (found in play(name, Plan(point, k, fault)).second) failures += "$name: ${point.name.lowercase()} #$k ${fault.name.lowercase()}: $found"
                }
            }
        }
        assertTrue(tried > 100)
        assertEquals(emptyList<String>(), failures)
        pool.shutdown()
    }
}
