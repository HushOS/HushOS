package com.hushos.app.files

import android.content.pm.ProviderInfo
import android.os.Looper
import android.os.ParcelFileDescriptor
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import com.hushos.app.data.DriveApi
import com.hushos.app.data.FailedTransfers
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.Mirror
import com.hushos.app.data.Shared
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.UploadWorker
import com.hushos.app.data.Vault
import com.hushos.app.data.WriteBacks
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/*
 * Another app's saves of one file through the Files app land newest last, whatever happens to the older ones: each takes
 * its place in its close callback, none is chained to another (one cancelled, failed for good or retrying never keeps a
 * newer one from landing), an older one that finds a newer one landed is superseded, a Retry keeps its place, and an
 * edit opened to read and write starts from the newest save not landed yet. Through the real provider, its close
 * callback, the transfer queue and UploadWorker, against FakeDrive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FilesSaveOrderTest {
    private val server = FakeDrive()
    private val app get() = RuntimeEnvironment.getApplication()
    /* The provider's write-backs, held here so a test decides which thread gets further first. */
    private val spawned = ArrayList<Runnable>()

    @Before
    fun signIn() {
        // The mirror is one per process and Robolectric keeps statics between tests: each test starts from an empty one.
        Mirror::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        app.deleteDatabase("mirror.db")
        FamilyFixture.signIn(server, "files-save-order-test")
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build())
        WriteBacks.forgetAll(app)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun provider(): HushOSDocumentsProvider {
        val info = ProviderInfo().apply {
            authority = "${app.packageName}.documents"
            exported = true
            grantUriPermissions = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
        }
        return Robolectric.buildContentProvider(HushOSDocumentsProvider::class.java).create(info).get().also { it.spawn = { job -> spawned.add(job) } }
    }

    /* A file of the drive, listed through the provider. */
    private fun notes(provider: HushOSDocumentsProvider): String =
        server.file(server.root, "Notes.txt", "original".toByteArray()).also { provider.queryChildDocuments("root", null, null as String?).close() }

    /* Another app opens the file, writes `text` and closes it, through the provider's real close callback. */
    private fun save(provider: HushOSDocumentsProvider, notes: String, text: String, mode: String = "w") {
        val pfd = provider.openDocument(notes, mode, null)
        ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { it.write(text.toByteArray()) }
        shadowOf(Looper.getMainLooper()).idle()
    }

    /* What another app opening the file in `mode` starts from. */
    private fun opened(provider: HushOSDocumentsProvider, notes: String, mode: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument(notes, mode, null)).use { it.readBytes().decodeToString() }

    /* The provider's own uploads (and every begin) get no answer while set. */
    private fun dropBegins(drop: Boolean) {
        server.beforeAnswer = if (!drop) null else { method, path -> if (method == "POST" && path == "drive/uploads") throw IllegalStateException("dropped") }
    }

    /* Every begin is refused for good (a 400) while set. */
    private fun refuseBegins(refuse: Boolean) {
        server.extraRoutes = if (!refuse) null else { method, segments, _, _ ->
            if (method == "POST" && segments == listOf("drive", "uploads")) 400 to JSONObject().put("message", "Refused.") else null
        }
    }

    private fun runSpawned() { val jobs = spawned.toList(); spawned.clear(); jobs.forEach { it.run() } }

    private fun serverText(notes: String): String {
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        Vault(app, DriveApi(Shared.session(app)!!)).apply { listChildren(server.root) }.download(notes, out)
        return out.readText()
    }

    /* The write-backs queued for the file, oldest save first. */
    private fun queued(): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get()
        .filter { info -> info.tags.any { it.startsWith(WriteBacks.ORDER) } }
        .sortedBy { info -> info.tags.first { it.startsWith(WriteBacks.ORDER) }.removePrefix(WriteBacks.ORDER).toLong() }

    /* A queued save's job, run as WorkManager starts it: its request rebuilt from what WorkManager holds (tags checked). */
    private fun runJob(info: WorkInfo, notes: String): ListenableWorker.Result {
        val tag = { prefix: String -> info.tags.first { it.startsWith(prefix) }.removePrefix(prefix) }
        val request = TransferQueue.uploadRequest(info.id, File(tag("file:")), "text/plain", server.root, notes, ledger = tag("ledger:"),
            session = TransferQueue.accountTag(Shared.session(app)!!), chain = tag(WriteBacks.CHAIN), order = tag(WriteBacks.ORDER).toLong())
        assertEquals(request.tags, info.tags)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(info.id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        return runBlocking { worker.doWork() }
    }

    /*
     * Two closes back to back, the second's write-back getting further first: the second lands, and the first, finding
     * it landed, is superseded, so the file is the second save. Fails if a save's place is taken anywhere but its close
     * callback (the older would land last and replace the newer).
     */
    @Test
    fun twoClosesBackToBackLandInTheirOrderWhicheverThreadRunsFirst() {
        val provider = provider()
        val notes = notes(provider)
        save(provider, notes, "first save")
        save(provider, notes, "second save")
        assertEquals(2, spawned.size)
        spawned.reversed().forEach { it.run() }
        spawned.clear()
        assertEquals("second save", serverText(notes))
    }

    /*
     * The first save's upload gets no answer (queued), the second is queued behind it, and the first is cancelled from the
     * transfers panel: the second is still runnable and lands. Fails if saves are chained so one cancelled takes the
     * ones after it down.
     */
    @Test
    fun aCancelledSaveNeverStopsTheNextFromLanding() {
        val provider = provider()
        val notes = notes(provider)
        dropBegins(true)
        save(provider, notes, "first save"); runSpawned()
        save(provider, notes, "second save"); runSpawned()
        dropBegins(false)
        val (first, second) = queued()
        WorkManager.getInstance(app).cancelWorkById(first.id).result.get()
        assertEquals(WorkInfo.State.ENQUEUED, WorkManager.getInstance(app).getWorkInfoById(second.id).get()!!.state)
        assertEquals(ListenableWorker.Result.success(), runJob(second, notes))
        assertEquals("second save", serverText(notes))
    }

    /*
     * The first save fails for good (the server refuses it): the second, queued too, is still runnable and lands, and
     * the first stays on the list with its copy, to retry. Then the first is retried while the second is current: its
     * Retry keeps its place, finds the second landed and is superseded, so the file stays the second save. Fails if a
     * failed save stops the next, or a Retry of an older save lands over a newer one.
     */
    @Test
    fun aFailedSaveNeverStopsTheNextAndItsRetryNeverLandsOverIt() {
        val provider = provider()
        val notes = notes(provider)
        dropBegins(true)
        save(provider, notes, "first save"); runSpawned()
        save(provider, notes, "second save"); runSpawned()
        dropBegins(false)
        val (first, second) = queued()
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runJob(first, notes)::class)
        refuseBegins(false)
        assertEquals(WorkInfo.State.ENQUEUED, WorkManager.getInstance(app).getWorkInfoById(second.id).get()!!.state)
        val row = FailedTransfers.of(app).all().single { it.id == first.id.toString() }
        assertFalse("the failed save can't be retried", row.sourceGone())
        assertEquals(ListenableWorker.Result.success(), runJob(second, notes))
        assertEquals("second save", serverText(notes))
        assertEquals(true, TransferQueue.retry(app, row))
        val retried = queued().single { it.id != first.id && it.id != second.id }
        assertEquals(ListenableWorker.Result.success(), runJob(retried, notes))
        assertEquals("the retried older save landed over the newer one", "second save", serverText(notes))
    }

    /*
     * A save still queued (its upload got no answer), then the app opens the file to read and write: it starts from that
     * save, not the server's older version. Fails if the edit is seeded from the server while a newer save is queued.
     */
    @Test
    fun anOpenToReadAndWriteStartsFromTheSaveStillQueued() {
        val provider = provider()
        val notes = notes(provider)
        dropBegins(true)
        save(provider, notes, "first save"); runSpawned()
        dropBegins(false)
        assertEquals("first save", opened(provider, notes, "rw"))
    }

    /*
     * A job whose earlier run landed ends (its landed row: the account's lock, then the document's) while a save of the
     * same file is uploading (the document's lock, then the upload ledger's, the account's): both finish. Fails if the two
     * paths take the locks in opposite orders (a deadlock that also holds up sign-out).
     */
    @Test
    fun aLandedJobEndingAndASaveUploadingNeverWaitOnEachOther() {
        val provider = provider()
        val notes = notes(provider)
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        val chain = WriteBacks.chainOf(vault.resolve(notes).node.workspaceId, notes)
        val job = java.util.UUID.randomUUID()
        val staged = File(app.filesDir, "queue/$job/content").apply { parentFile!!.mkdirs(); writeText("landed before") }
        val upload = "00000000-0000-4000-8000-0000000000cc"
        com.hushos.app.data.Reservations.reserved(app, upload, vault.resolve(notes).node.workspaceId, job.toString(), System.currentTimeMillis(), null)
        com.hushos.app.data.Reservations.idle(upload)
        com.hushos.app.data.Reservations.completed(app, upload)
        val request = TransferQueue.uploadRequest(job, staged, "text/plain", server.root, notes, session = TransferQueue.accountTag(Shared.session(app)!!),
            chain = chain, order = WriteBacks.nextOrder(app))
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(job).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val uploader = Thread {
            WriteBacks.land(app, chain, WriteBacks.nextOrder(app)) { holding.countDown(); release.await(); com.hushos.app.data.Reservations.all(app) }
        }.apply { isDaemon = true; start() }
        holding.await()
        var ended: ListenableWorker.Result? = null
        val ender = Thread { ended = runBlocking { worker.doWork() } }.apply { isDaemon = true; start() }
        // The ending job goes as far as it can while the save holds the document.
        Thread.sleep(500)
        release.countDown()
        uploader.join(10_000)
        ender.join(10_000)
        assertFalse("the save uploading never finished", uploader.isAlive)
        assertFalse("the landed job's end never finished", ender.isAlive)
        assertEquals(ListenableWorker.Result.success(), ended)
    }

    /*
     * Saves made before the phone's clock moved back, so far back that the clock now reads less than their places, and the
     * app restarted: a new save still outranks them and lands. Fails if a save's place comes from the clock (a new save
     * would be superseded by older ones).
     */
    @Test
    fun aNewSaveOutranksOlderOnesAfterARestartAndTheClockMovingBack() {
        val provider = provider()
        val notes = notes(provider)
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        val chain = WriteBacks.chainOf(vault.resolve(notes).node.workspaceId, notes)
        // Places handed out while the clock read a day ahead: kept on disk, the newest landed.
        val ahead = (System.currentTimeMillis() + 86_400_000L) * 1000
        app.getSharedPreferences("write-back-order", android.content.Context.MODE_PRIVATE).edit().putLong("next", ahead).commit()
        WriteBacks.markLanded(app, chain, ahead)
        // The process restarts: nothing it held in memory survives.
        WriteBacks::class.java.declaredFields.filter { it.name == "last" }.forEach { it.isAccessible = true; it.setLong(WriteBacks, 0L) }
        assertTrue(WriteBacks.nextOrder(app) > ahead)
        save(provider, notes, "after the restart")
        runSpawned()
        assertEquals("after the restart", serverText(notes))
    }

    /*
     * A superseded save's job ends as done and its copy goes; WorkManager runs it again (it died after the copy went, before
     * its end was recorded): the rerun ends as done too. Fails if a superseded job deletes its copy before keeping its
     * success (the rerun would fail as "pick it again").
     */
    @Test
    fun aSupersededSaveRerunAfterItsCopyWentEndsAsDone() {
        val provider = provider()
        val notes = notes(provider)
        dropBegins(true)
        save(provider, notes, "first save"); runSpawned()
        dropBegins(false)
        save(provider, notes, "second save"); runSpawned()
        assertEquals("second save", serverText(notes))
        val first = queued().single()
        assertEquals(ListenableWorker.Result.success(), runJob(first, notes))
        assertFalse(File(first.tags.first { it.startsWith("file:") }.removePrefix("file:")).exists())
        assertEquals(ListenableWorker.Result.success(), runJob(first, notes))
        assertEquals("second save", serverText(notes))
    }

    /*
     * Signing out (the account's wipe) takes every file's landed place with it: nothing of the account stays. Fails if the
     * landed places outlive the sign-out.
     */
    @Test
    fun signingOutForgetsWhichSavesLanded() {
        val provider = provider()
        val notes = notes(provider)
        save(provider, notes, "a save"); runSpawned()
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        val chain = WriteBacks.chainOf(vault.resolve(notes).node.workspaceId, notes)
        assertTrue(WriteBacks.landed(app, chain) > 0)
        com.hushos.app.data.AccountStore.of(app).wipe()
        assertEquals(0L, WriteBacks.landed(app, chain))
        assertTrue(File(app.applicationInfo.dataDir, "shared_prefs/write-backs.xml").let { !it.exists() || !it.readText().contains(chain) })
    }
}
