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
import com.hushos.app.data.AccountStore
import com.hushos.app.data.DriveApi
import com.hushos.app.data.FailedTransfers
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.Mirror
import com.hushos.app.data.Reservations
import com.hushos.app.data.Shared
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.UploadWorker
import com.hushos.app.data.Vault
import com.hushos.app.data.WriteBacks
import com.hushos.app.data.buildCatalogue
import com.hushos.app.data.sync
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/*
 * Another app's saves of one file through the Files app, coalesced into one pending slot per file (WriteBacks): only the
 * newest save is ever sent, an older one can never land after a newer one, the newest always gets its chance, and every
 * open reads what the app last saved. Through the real provider, its close callback, the transfer queue and the slot's
 * UploadWorker run, against FakeDrive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FilesSaveOrderTest {
    private val server = FakeDrive()
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        // The mirror is one per process and Robolectric keeps statics between tests: each test starts from an empty one.
        Mirror::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        app.deleteDatabase("mirror.db")
        FamilyFixture.signIn(server, "files-save-order-test")
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build())
    }

    @After
    fun close() {
        WriteBacks.afterContent = null
        WriteBacks.beforeSlotId = null
        WriteBacks.fault = null
        FailedTransfers.beforeWrite = null
        TransferQueue.beforeSlotFails = null
        TransferQueue.afterCancelCleans = null
        TransferQueue.beforeSweepRemoves = null
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
        return Robolectric.buildContentProvider(HushOSDocumentsProvider::class.java).create(info).get()
    }

    private fun vaultOf(provider: HushOSDocumentsProvider) =
        HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault

    /* A file of the drive (in `parent`), listed through the provider. */
    private fun notes(provider: HushOSDocumentsProvider, parent: String = server.root): String =
        server.file(parent, "Notes.txt", "original".toByteArray()).also {
            provider.queryChildDocuments("root", null, null as String?).close()
            if (parent != server.root) provider.queryChildDocuments(parent, null, null as String?).close()
        }

    private fun slotOf(provider: HushOSDocumentsProvider, notes: String) = WriteBacks.slotOf(vaultOf(provider).resolve(notes).node.workspaceId, notes)

    /* Another app opens the file, writes `text` and closes it, through the provider's real close callback. */
    private fun save(provider: HushOSDocumentsProvider, notes: String, text: String, mode: String = "w") {
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(notes, mode, null)).use { it.write(text.toByteArray()) }
        // The close callbacks' own thread (WriteBacks.closes), run until the save is kept.
        shadowOf(WriteBacks.closes.looper).idle()
    }

    /* What another app opening the file in `mode` reads. */
    private fun opened(provider: HushOSDocumentsProvider, notes: String, mode: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument(notes, mode, null)).use { it.readBytes().decodeToString() }

    private fun serverText(notes: String): String {
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        Vault(app, DriveApi(Shared.session(app)!!)).apply { buildCatalogueQuietly() }.download(notes, out)
        return out.readText()
    }

    private fun Vault.buildCatalogueQuietly() = runCatching { listChildren(server.root) }

    /* The slot's jobs, as WorkManager holds them. */
    private fun jobs(slot: String): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosByTag(WriteBacks.SLOT + slot).get()

    /*
     * The slot's job run as WorkManager starts it: a run of it (each with its own id, as a rerun or the next job behind it
     * would be), its request what TransferQueue queued for the slot (WorkManager holds a job with those tags), naming the
     * generation the slot held when it was queued, however many saves replaced it since.
     */
    private fun runSlot(slot: String): ListenableWorker.Result {
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val queued = jobs(slot)
        assertTrue("no job was queued for the slot", queued.isNotEmpty())
        val file = File(queued.last().tags.first { it.startsWith("file:") }.removePrefix("file:"))
        assertEquals(TransferQueue.slotRequest(queued.last().id, slot, file, session = session).tags, queued.last().tags)
        val id = java.util.UUID.randomUUID()
        val request = TransferQueue.slotRequest(id, slot, file, session = session)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        return runBlocking { worker.doWork() }
    }

    /* A run of the slot's job under `id` (a job WorkManager holds), as WorkManager starts it. */
    private fun runSlotAs(slot: String, id: java.util.UUID): ListenableWorker.Result {
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val file = File(jobs(slot).first().tags.first { it.startsWith("file:") }.removePrefix("file:"))
        val request = TransferQueue.slotRequest(id, slot, file, session = session)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        return runBlocking { worker.doWork() }
    }

    private fun posted() = shadowOf(app.getSystemService(android.app.NotificationManager::class.java)).allNotifications

    /* A second job of the slot queued behind the first (as a save made while the first ran queues one). */
    private fun secondJob(slot: String): java.util.UUID {
        val request = TransferQueue.slotRequest(java.util.UUID.randomUUID(), slot, WriteBacks.contentOf(app, slot), session = TransferQueue.accountTag(Shared.session(app)!!))
        WorkManager.getInstance(app).enqueue(request).result.get()
        return request.id
    }

    /* The network drops as a completion lands: its answer, and every answer after it, lost. */
    private fun dropFromTheCompletion() {
        var dropping = false
        server.dropReply = { method, path -> (dropping || (method == "POST" && path.endsWith("/complete"))).also { if (it) dropping = true } }
    }

    private fun begins() = server.requests.count { it == "POST /api/drive/uploads" }

    /* Every begin refused for good (a 400) while set. */
    private fun refuseBegins(refuse: Boolean) {
        server.extraRoutes = if (!refuse) null else { method, segments, _, _ ->
            if (method == "POST" && segments == listOf("drive", "uploads")) 400 to JSONObject().put("message", "Refused.") else null
        }
    }

    /*
     * Two closes back to back through the real close callback: the slot holds the second, one job sends it, and the first
     * is never sent. Fails if a save's place is taken anywhere but its close, or a save is sent other than from the slot.
     */
    @Test
    fun twoClosesBackToBackLeaveTheSecondAndSendOnlyIt() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        save(provider, notes, "second save")
        assertEquals(0, begins())
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals(1, begins())
        assertEquals("second save", serverText(notes))
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * The first save's job is cancelled from the transfers panel (its slot dropped); a later save still gets its own job
     * and lands. Fails if a cancelled save keeps a later one from landing.
     */
    @Test
    fun aCancelledSaveNeverKeepsALaterOneFromLanding() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val first = jobs(slot).single()
        TransferQueue.cancel(app, first.id, WriteBacks.contentOf(app, slot).path).get()
        assertNull(WriteBacks.pending(app, slot))
        save(provider, notes, "second save")
        assertEquals(WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != first.id }.state)
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
    }

    /*
     * The first save's completion lands with its answer lost, and the user cancels it before the next run; the slot
     * empties, so the next save counts from one again. That save is sent and lands. Fails if a save is known to the upload
     * ledger by its count, so the cancelled save's late-found completion stands in for the new one.
     */
    @Test
    fun aCancelledSaveWhoseCompletionLandedNeverStandsInForALaterOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        server.dropReply = null
        TransferQueue.cancel(app, jobs(slot).last().id, WriteBacks.contentOf(app, slot).path).get()
        assertNull(WriteBacks.pending(app, slot))
        save(provider, notes, "second save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals(2, begins())
        assertEquals("second save", serverText(notes))
    }

    /*
     * While a run's completion is landing, the user cancels the file's save and the other app saves it again (the slot
     * emptied, so the new save counts from one, as the one landing did). The run's landing leaves the new save, and sends
     * it next. Fails if landing clears the slot by a save's count rather than the save itself.
     */
    @Test
    fun aSaveMadeAfterACancelIsNeverClearedByTheRunLandingTheOldOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val target = WriteBacks.pending(app, slot)!!.target
        server.beforeAnswer = { method, path ->
            if (method == "POST" && path.endsWith("/complete")) {
                server.beforeAnswer = null
                WriteBacks.drop(app, slot)
                val edit = File(app.cacheDir, "again").apply { writeText("second save") }
                assertEquals(1L, WriteBacks.save(app, Reservations.generation, target, edit)!!.generation)
            }
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * The first save fails for good (the server refuses it): the slot stays, with the failed row's Retry; a later save
     * replaces the slot and its new job lands it; the old row's Retry then sends whatever the slot holds (nothing: the
     * newest landed), never the old save. A Retry while a newer save is still queued sends the newer. Fails if a failed
     * save stops a later one, or a Retry ever sends an older save over a newer one.
     */
    @Test
    fun aFailedSaveKeepsItsRetryAndNeverLandsOverANewerOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runSlot(slot)::class)
        refuseBegins(false)
        val row = FailedTransfers.of(app).all().single()
        assertEquals(slot, row.slot)
        assertFalse("the failed save can't be retried", row.sourceGone())
        // A Retry while a newer save is queued: it sends the newer.
        save(provider, notes, "second save")
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
        // Another failure, a newer save landed by its own job, then the old row's Retry: nothing older is sent.
        save(provider, notes, "third save")
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runSlot(slot)::class)
        refuseBegins(false)
        val again = FailedTransfers.of(app).all().single()
        save(provider, notes, "fourth save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("fourth save", serverText(notes))
        val sent = begins()
        if (TransferQueue.retry(app, again)) assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals(sent, begins())
        assertEquals("fourth save", serverText(notes))
    }

    /*
     * A save is refused for good while a newer save arrives during its upload: the job sends the newer one in the same
     * run and lands it, with no failed row. Fails if an older save's failure keeps a newer one from its own try.
     */
    @Test
    fun aNewerSaveGetsItsOwnTryWhenTheOlderOneFails() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "refused save")
        val target = WriteBacks.pending(app, slot)!!.target
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments == listOf("drive", "uploads")) {
                server.extraRoutes = null
                WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "newer").apply { writeText("newer save") })
                400 to JSONObject().put("message", "Refused.")
            } else null
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("newer save", serverText(notes))
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * The network drops as a save's completion lands: its answer, and everything after it in that run, lost. The slot
     * stays; then a newer save arrives. The next run settles the lost upload first (found completed), sends only the
     * newest, and the version left is the newest. Then the newest's own completion answer is lost the same way: the next
     * run finds it landed and sends nothing again, though the slot had emptied in between and counted from one again.
     * Fails if an uncertain completion is sent again, an older save can land after a newer one, a later save is taken for
     * an earlier one with the same count, or a landed row outlives its slot.
     */
    @Test
    fun anUncertainCompletionIsSettledNeverSentAgainOrFollowedByAnOlderSave() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        server.dropReply = null
        assertEquals(1, begins())
        assertEquals("first save", serverText(notes))
        save(provider, notes, "second save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("first save was sent again", 2, begins())
        assertEquals("second save", serverText(notes))
        // The newest's own completion answer lost: found landed on the next look, never sent again.
        save(provider, notes, "third save")
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        server.dropReply = null
        assertEquals(3, begins())
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("the landed save was sent again", 3, begins())
        assertEquals("third save", serverText(notes))
        assertNull(WriteBacks.pending(app, slot))
        // No landed row of the slot's saves is left over (the first, found landed while the second was pending, too).
        assertTrue(Reservations.all(app).none { WriteBacks.ledgerOf(slot, it.job) })
    }

    /*
     * While a save is pending (its job waiting), an app opening the file to read (`r`), or to read and write, gets that
     * save, not the server's older version; one that then truncates and writes keeps building on it. Fails if any open
     * reads past the pending save.
     */
    @Test
    fun everyOpenReadsThePendingSave() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        assertEquals("first save", opened(provider, notes, "r"))
        assertEquals("first save", opened(provider, notes, "rw"))
        save(provider, notes, opened(provider, notes, "r") + " then more", mode = "wt")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("first save then more", serverText(notes))
    }

    /*
     * A save failed for good and its job is long pruned from WorkManager: the slot still holds it, and every open reads it.
     * Fails if a failed save stops counting once WorkManager forgets its job.
     */
    @Test
    fun aFailedSaveStillCountsAfterItsJobIsPruned() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "failed save")
        refuseBegins(true)
        runSlot(slot)
        refuseBegins(false)
        WorkManager.getInstance(app).pruneWork().result.get()
        assertEquals("failed save", opened(provider, notes, "r"))
        assertEquals("failed save", opened(provider, notes, "rw"))
    }

    /*
     * Another device moves the file out of its folder and deletes the folder before the save's job runs: the job finds
     * the file by its node where it is now and lands the save. Fails if the job looks for the file through the folder it
     * was in when the app opened it.
     */
    @Test
    fun aSaveOfAFileMovedElsewhereLandsWhereItIsNow() {
        val provider = provider()
        val trips = server.folder(server.root, "Trips")
        val notes = notes(provider, trips)
        val slot = slotOf(provider, notes)
        save(provider, notes, "saved before the move")
        server.moveAs(notes, server.root)
        server.purgeAs(trips)
        // This device has caught up since (its feed, started over as after a dropped tombstone): the folder is gone here too.
        server.tombstonesDroppedThrough = Int.MAX_VALUE
        vaultOf(provider).let { vault ->
            vault.buildCatalogue()
            vault.sync()
            assertNull(vault.item(trips))
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("saved before the move", serverText(notes))
    }

    /*
     * An open arriving while a save is being published (its contents in place, its record not yet) waits for it and reads
     * the new save: pending contents are never out of sight, not even for the moment between the two. Fails if an open
     * can read the slot (or past it to the server) in the middle of a save.
     */
    @Test
    fun anOpenDuringASaveWaitsForItAndReadsIt() {
        val provider = provider()
        val notes = notes(provider)
        val vault = vaultOf(provider)
        val reading = CountDownLatch(1)
        var read: String? = null
        var readEarly = false
        WriteBacks.afterContent = {
            WriteBacks.afterContent = null
            Thread { read = provider.personalEdit(vault, notes, "rw").readText(); reading.countDown() }.start()
            readEarly = reading.await(300, TimeUnit.MILLISECONDS)
        }
        save(provider, notes, "first save")
        assertTrue(reading.await(10, TimeUnit.SECONDS))
        assertFalse("an open read the slot in the middle of a save", readEarly)
        assertEquals("first save", read)
    }

    /*
     * Saves arriving one after another while the job sends (the slot's lock against the account's, both ways): every one
     * finishes, and the version left is the last save. Fails if the save and the landing take the locks in opposite
     * orders (a deadlock that also holds up sign-out).
     */
    @Test
    fun savesWhileTheJobLandsNeverDeadlockAndTheLastWins() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "save 0")
        val vault = vaultOf(provider)
        val opened = vault.resolve(notes)
        val saver = Thread {
            for (i in 1..20) {
                val edit = File(app.cacheDir, "edit-$i").apply { writeText("save $i") }
                provider.onEditClosed(null, vault, edit, opened)
            }
        }.apply { isDaemon = true }
        val sender = Thread { runSlot(slot) }.apply { isDaemon = true }
        saver.start(); sender.start()
        saver.join(30_000); sender.join(30_000)
        assertFalse("the saves never finished", saver.isAlive)
        assertFalse("the job never finished", sender.isAlive)
        if (WriteBacks.pending(app, slot) != null) assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("save 20", serverText(notes))
    }

    /*
     * The app restarts with a save pending (its job not run): the slot is still there, a fresh provider's opens read it,
     * and the job sends it. Fails if a pending save lives only in memory.
     */
    @Test
    fun aPendingSaveOutlivesARestart() {
        val first = provider()
        val notes = notes(first)
        val slot = slotOf(first, notes)
        save(first, notes, "saved before the restart")
        val fresh = provider()
        fresh.queryChildDocuments("root", null, null as String?).close()
        assertEquals("saved before the restart", opened(fresh, notes, "r"))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("saved before the restart", serverText(notes))
    }

    /*
     * The process dies between a save landing in its slot and its job being queued: the next sweep of the queue (the
     * transfers panel's) finds the slot without a job and queues one, which lands it. Fails if a save left without its
     * job waits for ever, or is swept away.
     */
    @Test
    fun aSaveLeftWithoutItsJobGetsOneAtTheNextSweep() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        val opened = vaultOf(provider).resolve(notes)
        val edit = File(app.cacheDir, "unqueued").apply { writeText("saved, then the process died") }
        WriteBacks.save(app, Reservations.generation, WriteBacks.Target(opened.node.workspaceId, notes, opened.name, opened.metadata.mime, opened.node.parentId!!), edit)
        assertTrue(jobs(slot).isEmpty())
        TransferQueue.sweep(app, inUse = emptySet())
        assertEquals(WorkInfo.State.ENQUEUED, jobs(slot).single().state)
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("saved, then the process died", serverText(notes))
    }

    /*
     * A save cut short after its contents and description were written and before the record named them (the process
     * killed there), right after the save before it landed with its answer lost: the slot never holds the new bytes under
     * the earlier save's identity. The next look publishes the newer save under its own id, the next run settles the
     * earlier one as landed and sends the newer. Fails if a save's bytes and identity can change apart, so the newer bytes
     * pass for the landed save and are cleared unsent, or the cut-short save is lost.
     */
    @Test
    fun aSaveCutShortBeforeItsRecordIsNeitherLostNorMislabelled() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val first = WriteBacks.pending(app, slot)!!
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        server.dropReply = null
        class Killed : Error()
        WriteBacks.afterContent = { WriteBacks.afterContent = null; throw Killed() }
        val edit = File(app.cacheDir, "cut-short").apply { writeText("second save") }
        try {
            WriteBacks.save(app, Reservations.generation, first.target, edit)
            throw AssertionError("the save wasn't cut short")
        } catch (_: Killed) {
        }
        val second = WriteBacks.pending(app, slot)!!
        assertTrue(second.id != first.id)
        assertEquals("second save", WriteBacks.contentOf(app, slot).readText())
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
        assertEquals(2, begins())
    }

    /*
     * A file read once (its version cached here), then saved, and the save's job lands it from its own vault: the next
     * read gets the new bytes, not the provider's cached version from before. Fails if a read-only open answers from the
     * provider's own row once the slot has emptied.
     */
    @Test
    fun aReadAfterTheSaveLandsReadsTheNewVersion() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        assertEquals("original", opened(provider, notes, "r"))
        save(provider, notes, "landed save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertNull(WriteBacks.pending(app, slot))
        assertEquals("landed save", opened(provider, notes, "r"))
    }

    /*
     * A save fails for good (its row), then a newer one lands: the failed save's row goes, and WorkManager's failed entry
     * for it, read by the panel, never makes it again. Fails if a row the slot made obsolete stays, or comes back.
     */
    @Test
    fun aLandedSaveRetiresTheRowsOfTheFailedOnesBeforeIt() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "failed save")
        val failedFile = WriteBacks.contentOf(app, slot).path
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runSlot(slot)::class)
        refuseBegins(false)
        val row = FailedTransfers.of(app).all().single()
        assertEquals(failedFile, row.file)
        save(provider, notes, "newer save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val request = TransferQueue.slotRequest(java.util.UUID.fromString(row.id), slot, File(failedFile), session = session)
        val entry = WorkInfo(request.id, WorkInfo.State.FAILED, request.tags, androidx.work.Data.Builder().putAll(request.workSpec.input).putString("message", "Refused.").build())
        TransferQueue.recordUnrecordedFailures(app, listOf(entry), emptySet(), Reservations.generation) { "Notes.txt" }
        assertTrue("a pruned-late entry made the obsolete row again", FailedTransfers.of(app).all().isEmpty())
    }

    /*
     * A save fails for good (its row), a newer save is pending, and the failed save's row is dismissed: only the failed
     * save goes, the newer one stays and lands. Dismissing the row of a failed save that is still the pending one drops
     * it. Fails if a dismissal deletes the slot's current contents, or leaves a failed pending save behind.
     */
    @Test
    fun dismissingAFailedSaveNeverTakesANewerOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "failed save")
        refuseBegins(true)
        runSlot(slot)
        refuseBegins(false)
        save(provider, notes, "pending save")
        TransferQueue.dismiss(app, FailedTransfers.of(app).all().single())
        assertEquals("pending save", opened(provider, notes, "r"))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("pending save", serverText(notes))
        save(provider, notes, "failed again")
        refuseBegins(true)
        runSlot(slot)
        refuseBegins(false)
        TransferQueue.dismiss(app, FailedTransfers.of(app).all().single())
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * A save's completion lands but the step after it fails (its name signed again), so the run counts it landed; a newer
     * save arrived meanwhile and goes out in the same run. It replaces the version that just landed. Fails if the next
     * save is sent from the vault that still holds the version before (the server refuses a replacement of a stale version).
     */
    @Test
    fun theNextSaveAfterARecoveredLandingReplacesTheVersionThatLanded() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val target = WriteBacks.pending(app, slot)!!.target
        server.extraRoutes = { method, segments, _, _ ->
            if (method != "GET" && segments.size == 4 && segments[1] == "nodes" && segments[3] == "metadata") {
                server.extraRoutes = null
                WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "meanwhile").apply { writeText("second save") })
                500 to JSONObject().put("message", "The connection dropped")
            } else null
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * A file's earlier save's job finished (WorkManager still lists it), and a new save landed in the slot without its job
     * (the process died first): the next sweep queues one, since a finished job owns nothing. Fails if a finished job's
     * folder counts as owning the slot.
     */
    @Test
    fun aSaveWhoseOnlyJobHadFinishedGetsOneAtTheNextSweep() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val finished = jobs(slot).single()
        WorkManager.getInstance(app).cancelWorkById(finished.id).result.get()
        val target = WriteBacks.pending(app, slot)!!.target
        WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "unqueued").apply { writeText("second save") })
        TransferQueue.sweep(app, WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get())
        assertEquals(WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != finished.id }.state)
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
    }

    /*
     * Another app's close callback keeps its save on the saves' own thread, never the main one: copying a large file
     * under the slot's lock there would hold up every screen of the app. Fails if close callbacks run on the main looper.
     */
    @Test
    fun aSaveIsKeptOffTheMainThread() {
        val provider = provider()
        val notes = notes(provider)
        var onMain: Boolean? = null
        WriteBacks.afterContent = { WriteBacks.afterContent = null; onMain = Looper.myLooper() == Looper.getMainLooper() }
        save(provider, notes, "kept off the main thread")
        assertEquals(false, onMain)
        assertEquals("kept off the main thread", opened(provider, notes, "r"))
    }

    /*
     * A save's completion lands with its answer lost while a newer save arrives during that same upload: the run goes on to
     * the newer save, settles the earlier one as landed, and sends the newer one over the version that landed. Fails if
     * the newer save goes out from the vault that still holds the version before (the server refuses it for good).
     */
    @Test
    fun aNewerSaveAfterAnUncertainCompletionReplacesTheVersionThatLanded() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        val target = WriteBacks.pending(app, slot)!!.target
        // Every answer to the first save's completion lost (each try of it), the newer save arriving at the first.
        var first: String? = null
        server.dropReply = { method, path ->
            if (method == "POST" && path.endsWith("/complete") && first == null) {
                first = path
                WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "meanwhile").apply { writeText("second save") })
            }
            path == first
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
        assertNull(WriteBacks.pending(app, slot))
    }

    /*
     * An earlier save's completion answer is lost, and the next run can't settle it (its abort unanswered): a newer save
     * waits rather than starting while the earlier one could still land under it. Once the earlier one settles, the newer
     * goes. Fails if a save starts while an earlier save of the file has a reservation unsettled.
     */
    @Test
    fun aNewerSaveWaitsWhileAnEarlierOnesReservationIsUnsettled() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        save(provider, notes, "second save")
        server.dropReply = { _, path -> path.endsWith("/abort") }
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        assertEquals("a newer save started over an unsettled one", 1, begins())
        server.dropReply = null
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals(2, begins())
        assertEquals("second save", serverText(notes))
    }

    /*
     * A save queued behind its file's running job when that job failed for good: WorkManager fails it with its predecessor
     * without running it. The panel's rebuild makes no row of it, and the sweep gives the save a job of its own, which
     * lands. Fails if a predecessor's failure strands a newer save until a manual Retry.
     */
    @Test
    fun aSaveFailedOnlyWithItsPredecessorGetsAJobOfItsOwn() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "refused save")
        val failedFile = WriteBacks.contentOf(app, slot)
        val queued = jobs(slot).single()
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runSlot(slot)::class)
        refuseBegins(false)
        WorkManager.getInstance(app).cancelWorkById(queued.id).result.get()
        WriteBacks.save(app, Reservations.generation, WriteBacks.pending(app, slot)!!.target, File(app.cacheDir, "behind").apply { writeText("newer save") })
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val predecessor = TransferQueue.slotRequest(java.util.UUID.fromString(FailedTransfers.of(app).all().single().id), slot, failedFile, session = session)
        val behind = TransferQueue.slotRequest(java.util.UUID.randomUUID(), slot, WriteBacks.contentOf(app, slot), session = session)
        val infos = listOf(
            WorkInfo(predecessor.id, WorkInfo.State.FAILED, predecessor.tags, androidx.work.Data.Builder().putAll(predecessor.workSpec.input).putString("message", "Refused.").build()),
            WorkInfo(behind.id, WorkInfo.State.FAILED, behind.tags),
        )
        TransferQueue.recordUnrecordedFailures(app, infos, emptySet(), Reservations.generation) { "Notes.txt" }
        assertEquals(listOf(predecessor.id.toString()), FailedTransfers.of(app).all().map { it.id })
        TransferQueue.sweep(app, infos)
        assertEquals(WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != queued.id }.state)
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("newer save", serverText(notes))
        assertTrue(FailedTransfers.of(app).all().isEmpty())
    }

    /*
     * An earlier save finished on the server after the run's vault read its catalogue and before the run settled it (its
     * answer lost): the newer save goes out from a vault opened after the settling, so it replaces the version that landed.
     * Fails if the newer save is sent from the catalogue read before the settling (the server refuses it for good).
     */
    @Test
    fun aSaveAfterAnEarlierOneSettledReplacesTheVersionThatLanded() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runSlot(slot))
        server.dropReply = null
        save(provider, notes, "second save")
        // The first save's landing reaches the feed only once the run settles it, after its vault read the catalogue.
        server.missedByFeed.add(notes)
        server.beforeAnswer = { _, path -> if (path.endsWith("/abort")) { server.beforeAnswer = null; server.missedByFeed.remove(notes) } }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
    }

    /*
     * A file read after its save landed: the read checks the version with the server, and another save lands as that
     * check is answered (the answer predates it). The read after that gets the newer save, not the copy the check found.
     * Fails if a read takes a landing that came during its check for one it saw.
     */
    @Test
    fun aLandingDuringARefreshIsNeverTakenForSeen() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "first save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        // The next save lands as the read's check is answered: the answer (already made) predates it.
        var landing = true
        server.dropReply = { _, path ->
            if (landing && path.endsWith("/changes")) {
                landing = false
                WriteBacks.noteLanding(app, slot, null)
            }
            false
        }
        assertEquals("first save", opened(provider, notes, "r"))
        assertFalse("no save landed during the read", landing)
        server.dropReply = null
        server.newVersion(notes, "second save".toByteArray())
        assertEquals("second save", opened(provider, notes, "r"))
    }

    /*
     * Cancelling a file's save from the panel while the other app is saving it again (the new save holding the slot's lock
     * for a large file's copy, not published yet): the cancel returns at once; until its cleanup ran the job stays
     * unfinished, so the panel's sweep queues nothing; then the cancelled save goes, and the save made after the cancel was
     * pressed stays and gets a job of its own, which lands it. Fails if a cancel waits on the slot's lock on the caller's
     * thread, publishes the job's cancel before the slot is cleaned (the sweep then queues the cancelled save), or
     * deletes whatever the slot holds when its cleanup runs.
     */
    @Test
    fun aCancelTakesOnlyTheSavesBeforeItAndNeverWaits() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "cancelled save")
        val job = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        val holding = CountDownLatch(1)
        val release = CountDownLatch(1)
        WriteBacks.afterContent = { WriteBacks.afterContent = null; holding.countDown(); release.await(2, TimeUnit.SECONDS) }
        val saving = Thread { WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "large").apply { writeText("save after the cancel") }) }.apply { start() }
        assertTrue(holding.await(5, TimeUnit.SECONDS))
        val began = System.nanoTime()
        val cleanup = TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:"))
        val tookMs = (System.nanoTime() - began) / 1_000_000
        assertEquals("the job's cancel was published before the slot was cleaned", WorkInfo.State.ENQUEUED, jobs(slot).single().state)
        TransferQueue.sweep(app, WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get())
        assertEquals(1, jobs(slot).size)
        release.countDown()
        saving.join(5_000)
        cleanup.get(5, TimeUnit.SECONDS)
        assertTrue("the cancel waited ${tookMs}ms on the slot", tookMs < 1_000)
        assertEquals(WorkInfo.State.CANCELLED, jobs(slot).single { it.id == job.id }.state)
        assertEquals("the save left has no job", WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != job.id }.state)
        assertEquals("save after the cancel", opened(provider, notes, "r"))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("save after the cancel", serverText(notes))
    }

    /*
     * Cancel pressed for a file whose slot held nothing then (its earlier save had landed), while the other app's first
     * save of it is being written: that save stays and is sent. Fails if a cancel's cleanup deletes a slot it finds
     * empty, or one it finds holding a save made after the cancel was pressed.
     */
    @Test
    fun aCancelOfAnEmptySlotNeverTakesTheSaveBeingWritten() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "landed save")
        val job = jobs(slot).single()
        val file = job.tags.first { it.startsWith("file:") }.removePrefix("file:")
        val target = WriteBacks.pending(app, slot)!!.target
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        val holding = CountDownLatch(1)
        val release = CountDownLatch(1)
        WriteBacks.afterContent = { WriteBacks.afterContent = null; holding.countDown(); release.await(2, TimeUnit.SECONDS) }
        val saving = Thread { WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "new").apply { writeText("new save") }) }.apply { start() }
        assertTrue(holding.await(5, TimeUnit.SECONDS))
        val cleanup = TransferQueue.cancel(app, job.id, file)
        release.countDown()
        saving.join(5_000)
        cleanup.get(5, TimeUnit.SECONDS)
        assertEquals("new save", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * A file with a save waiting (its job not run) is listed with that save's size and date, the bytes a read returns,
     * not the server version's. Fails if a listing describes the server's version while reads return the pending save.
     */
    @Test
    fun aListingShowsThePendingSavesSizeAndDate() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        val before = System.currentTimeMillis()
        save(provider, notes, "a pending save, longer than the original")
        val kept = File(WriteBacks.dir(app, slot), WriteBacks.pending(app, slot)!!.id + ".bin")
        provider.queryDocument(notes, null).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("a pending save, longer than the original".length.toLong(), cursor.getLong(cursor.getColumnIndexOrThrow(android.provider.DocumentsContract.Document.COLUMN_SIZE)))
            val modified = cursor.getLong(cursor.getColumnIndexOrThrow(android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED))
            assertEquals(kept.lastModified(), modified)
            assertTrue(modified >= before - 1_000)
        }
    }

    /*
     * The sweep finds an old slot with nothing to send and no job, and a save is published there just before it removes
     * it: the save stays. Fails if the sweep removes a slot on the strength of a look it took without the slot's lock.
     */
    @Test
    fun aSweepNeverRemovesASavePublishedAfterItLooked() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "landed save")
        val target = WriteBacks.pending(app, slot)!!.target
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        val dir = WriteBacks.dir(app, slot).apply { mkdirs(); setLastModified(System.currentTimeMillis() - 3_600_000) }
        TransferQueue.beforeSweepRemoves = { seen ->
            if (seen == dir) {
                TransferQueue.beforeSweepRemoves = null
                WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "meanwhile").apply { writeText("published meanwhile") })
            }
        }
        TransferQueue.sweep(app, inUse = emptySet())
        assertEquals("published meanwhile", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * Cancel pressed for a waiting job; once the cancelled save went, and before the job's cancel is published, the other
     * app saves again and finds that job still waiting (so makes none of its own). After the cancel, the new save has a job
     * of its own and lands. Fails if the cancel decides what is left before its job's cancel is done.
     */
    @Test
    fun aSaveMadeWhileACancelIsPublishedGetsAJob() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "cancelled save")
        val job = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        TransferQueue.afterCancelCleans = {
            TransferQueue.afterCancelCleans = null
            WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "meanwhile").apply { writeText("save during the cancel") })
            assertEquals(job.id, TransferQueue.enqueueSlot(app, slot, "Notes.txt"))
        }
        TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:")).get(5, TimeUnit.SECONDS)
        assertEquals(WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != job.id }.state)
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("save during the cancel", serverText(notes))
    }

    /*
     * The job can't make its copy of the save to send (the disk refuses it; here something already stands at its path):
     * the job fails with a row for the save, no partial copy is left, and the row's Retry sends the save. Fails if a copy
     * failure escapes the job (no row, and the save waits for ever) or leaves the partial copy.
     */
    @Test
    fun aSaveThatCantBeCopiedForSendingFailsWithARowAndIsRetried() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "kept save")
        val kept = WriteBacks.pending(app, slot)!!
        val blocking = File(WriteBacks.dir(app, slot), "sending-${kept.id}").apply { mkdirs(); File(this, "in the way").writeText("x") }
        assertEquals(ListenableWorker.Result.failure()::class, runSlot(slot)::class)
        assertFalse("the partial copy was left", blocking.exists())
        val row = FailedTransfers.of(app).all().single()
        assertEquals(slot, row.slot)
        assertEquals(File(WriteBacks.dir(app, slot), kept.id + ".bin").path, row.file)
        assertFalse(row.sourceGone())
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("kept save", serverText(notes))
    }

    /*
     * A save kept tells Files that the file's folder changed (its listing now shows the save's size and date). Fails if a
     * save changes what a listing shows without telling the observers.
     */
    @Test
    fun aSaveTellsFilesItsFolderChanged() {
        val provider = provider()
        val notes = notes(provider)
        val notified = shadowOf(app.contentResolver)
        notified.notifiedUris.clear()
        save(provider, notes, "kept save")
        val authority = "${app.packageName}.documents"
        assertTrue(notified.notifiedUris.any { it.uri == android.provider.DocumentsContract.buildChildDocumentsUri(authority, "root") })
    }

    /*
     * A file read once (its version cached here), saved, and the save lands from its job's own vault; then this phone goes
     * offline. The next read serves the landed bytes (kept as the read copy of the version they became), not the cached
     * version before, which an editor that reads then saves would write over the landed save. When the landed version
     * isn't known (its answer was lost), the read fails rather than serve the version before. Fails if a read after a
     * landing can fall back to the version before it.
     */
    @Test
    fun aReadAfterALandingWithNoAnswerServesTheLandedBytes() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        assertEquals("original", opened(provider, notes, "r"))
        save(provider, notes, "landed save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        server.dropReply = { _, path -> path.endsWith("/changes") }
        assertEquals("landed save", opened(provider, notes, "r"))
        // A landing whose version isn't known: no answer, no read.
        WriteBacks.noteLanding(app, slot, null)
        assertThrows(java.io.FileNotFoundException::class.java) { opened(provider, notes, "r") }
        server.dropReply = null
        assertEquals("landed save", opened(provider, notes, "r"))
        assertNull(WriteBacks.landing(app, slot))
    }

    /*
     * A job is sending a save when Cancel is pressed for the file's other job, which would have sent that same save: the
     * sending job stops before the save lands (it honours the cancel), and a save made after the cancel is sent instead.
     * Fails if only the job Cancel named is stopped while another still lands the cancelled save.
     */
    @Test
    fun aCancelStopsTheJobAlreadySendingTheCancelledSave() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "cancelled save")
        val waiting = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        var pressed = false
        server.beforeAnswer = { method, path ->
            if (!pressed && method == "POST" && path == "drive/uploads") {
                pressed = true
                TransferQueue.cancel(app, waiting.id, waiting.tags.first { it.startsWith("file:") }.removePrefix("file:")).get(5, TimeUnit.SECONDS)
                WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "after").apply { writeText("save after the cancel") })
            }
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertTrue(pressed)
        assertEquals("save after the cancel", serverText(notes))
        assertEquals("the cancelled save was completed", 1, server.requests.count { it.startsWith("POST ") && it.endsWith("/complete") })
    }

    /*
     * A pending save cancelled, or its failed row dismissed: the file's listing goes back to the server's size and date, so
     * Files is told, at the URI its listing of the folder watches. Fails if a pending save goes without telling Files.
     */
    @Test
    fun aCancelOrADismissTellsTheFolderFilesIsWatching() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        val watched = provider.queryChildDocuments("root", null, null as String?).use { it.notificationUri }
        save(provider, notes, "cancelled save")
        val job = jobs(slot).single()
        shadowOf(app.contentResolver).notifiedUris.clear()
        TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:")).get(5, TimeUnit.SECONDS)
        assertTrue("a cancel didn't tell Files", shadowOf(app.contentResolver).notifiedUris.any { it.uri == watched })
        save(provider, notes, "dismissed save")
        refuseBegins(true)
        runSlot(slot)
        refuseBegins(false)
        shadowOf(app.contentResolver).notifiedUris.clear()
        TransferQueue.dismiss(app, FailedTransfers.of(app).all().single())
        assertNull(WriteBacks.pending(app, slot))
        assertTrue("a dismiss didn't tell Files", shadowOf(app.contentResolver).notifiedUris.any { it.uri == watched })
    }

    /*
     * Cancel pressed while the file's job is completing the save's upload: WorkManager stops the job, yet the completion
     * lands on the server. The job still does its landing's bookkeeping, so a read with no answer serves the landed bytes,
     * not the cached version before. Fails if stopping the job throws away an upload that landed.
     */
    @Test
    fun aJobStoppedDuringItsCompletionStillKeepsTheLanding() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        assertEquals("original", opened(provider, notes, "r"))
        save(provider, notes, "landed save")
        val job = jobs(slot).single()
        val file = job.tags.first { it.startsWith("file:") }.removePrefix("file:")
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val request = TransferQueue.slotRequest(job.id, slot, File(file), session = session)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(job.id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        runBlocking {
            val run = async(kotlinx.coroutines.Dispatchers.Default) { worker.doWork() }
            server.beforeAnswer = { method, path ->
                if (method == "POST" && path.endsWith("/complete")) {
                    server.beforeAnswer = null
                    TransferQueue.cancel(app, job.id, file).get(5, TimeUnit.SECONDS)
                    run.cancel()
                }
            }
            runCatching { run.await() }
        }
        assertNotNull("the landing's bookkeeping didn't run", WriteBacks.landing(app, slot))
        server.dropReply = { _, path -> path.endsWith("/changes") }
        assertEquals("landed save", opened(provider, notes, "r"))
    }

    /*
     * A job is sending a save when Cancel is pressed for it, and the other app saves again before the cancel's cleanup
     * runs (its newer save replaces the cancelled one's files): the cancel still holds for the save it was pressed for, so
     * the sending job stops before landing it, and the newer save is sent. Fails if a cancel finds its bound from the
     * cancelled save's files (gone by then), so the job already sending it completes it.
     */
    @Test
    fun aCancelHoldsWhenANewerSaveReplacesTheCancelledOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "cancelled save")
        val waiting = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        var pressed = false
        server.beforeAnswer = { method, path ->
            if (!pressed && method == "POST" && path == "drive/uploads") {
                pressed = true
                val holding = CountDownLatch(1)
                val release = CountDownLatch(1)
                WriteBacks.afterContent = { WriteBacks.afterContent = null; holding.countDown(); release.await(5, TimeUnit.SECONDS) }
                val saving = Thread { WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "newer").apply { writeText("newer save") }) }.apply { start() }
                assertTrue(holding.await(5, TimeUnit.SECONDS))
                val cleanup = TransferQueue.cancel(app, waiting.id, waiting.tags.first { it.startsWith("file:") }.removePrefix("file:"))
                release.countDown()
                saving.join(5_000)
                cleanup.get(5, TimeUnit.SECONDS)
            }
        }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertTrue(pressed)
        assertEquals("newer save", serverText(notes))
        assertEquals("the cancelled save was completed", 1, server.requests.count { it.startsWith("POST ") && it.endsWith("/complete") })
    }

    /*
     * Cancel pressed for a save that then lands before the cancel's cleanup runs, and the other app saves the file again
     * (the slot made afresh): the late cleanup takes nothing of the new slot. Fails if a cancel's bound, read on an earlier
     * slot of the file, takes a save of the slot that replaced it.
     */
    @Test
    fun aCancelPressedOnAnEarlierSlotTakesNothingOfTheNext() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "landed save")
        val pressed = WriteBacks.publishedSave(app, slot)!!
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertFalse(WriteBacks.dir(app, slot).exists())
        save(provider, notes, "next save")
        // Saves are numbered past the slot that went, so the next save is above the bound pressed on the earlier one.
        assertTrue(WriteBacks.pending(app, slot)!!.generation > pressed.generation)
        WriteBacks.cancelThrough(app, slot, pressed)
        assertEquals("next save", WriteBacks.contentOf(app, slot).readText())
        assertFalse(WriteBacks.isCancelled(app, slot, WriteBacks.pending(app, slot)!!.generation))
    }

    /*
     * Two reads after a save landed: the second looked the file up before the first refreshed it, and reads the landing
     * after the first cleared it. It still reads the landed version, not the row it looked up first. Fails if an open
     * serves the row it took before it read the landing.
     */
    @Test
    fun twoReadsAfterALandingNeverServeTheVersionBefore() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        assertEquals("original", opened(provider, notes, "r"))
        save(provider, notes, "landed save")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        val looked = CountDownLatch(1)
        val firstDone = CountDownLatch(1)
        provider.afterResolve = {
            if (Thread.currentThread().name == "second-reader") { looked.countDown(); firstDone.await(10, TimeUnit.SECONDS) }
        }
        var second: String? = null
        val reader = Thread({ second = opened(provider, notes, "r") }, "second-reader").apply { start() }
        assertTrue(looked.await(5, TimeUnit.SECONDS))
        assertEquals("landed save", opened(provider, notes, "r"))
        assertNull(WriteBacks.landing(app, slot))
        firstDone.countDown()
        reader.join(10_000)
        provider.afterResolve = null
        assertEquals("the second read served the version before the landing", "landed save", second)
    }

    /*
     * Off screen, a file's first job lands its save while a second job of the file is still queued, so the summary waits
     * for it; the second finds nothing left to send. Its end posts the summary. Fails if a job that sent nothing ends
     * without letting the gathered summary out (it then waits for ever).
     */
    @Test
    fun aSummaryWaitingOnAJobWithNothingToSendIsPostedWhenItEnds() {
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "landed save")
        val first = jobs(slot).single().id
        val second = secondJob(slot)
        assertEquals(ListenableWorker.Result.success(), runSlotAs(slot, first))
        assertTrue("posted while another job was queued", posted().isEmpty())
        assertEquals(ListenableWorker.Result.success(), runSlotAs(slot, second))
        assertEquals(1, posted().size)
    }

    /*
     * Off screen, a file's save fails for good while another job of the file is queued (its failure waits in the summary);
     * a newer save of the file then lands. The summary says the file uploaded, never that an upload didn't finish. Fails
     * if a failure the later upload made moot is still posted.
     */
    @Test
    fun aFailureALaterUploadMadeMootIsNeverPosted() {
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "refused save")
        val first = jobs(slot).single().id
        val second = secondJob(slot)
        refuseBegins(true)
        assertEquals(ListenableWorker.Result.failure()::class, runSlotAs(slot, first)::class)
        refuseBegins(false)
        // WorkManager's own record of the first job ends with it (run here outside WorkManager, it would stay queued).
        WorkManager.getInstance(app).cancelWorkById(first).result.get()
        assertTrue(posted().isEmpty())
        save(provider, notes, "newer save")
        assertEquals(ListenableWorker.Result.success(), runSlotAs(slot, second))
        val title = posted().single().extras.getString(android.app.Notification.EXTRA_TITLE)
        assertEquals("1 file uploaded", title)
    }

    /*
     * Another app closes the file and its save can't be kept in the slot (the disk refuses the slot's first write): its
     * edit, the only copy of what the app believes it saved, stays, with a row whose Retry keeps it and sends it. Fails if
     * a save that couldn't be kept deletes the edit.
     */
    @Test
    fun aSaveThatCantBeKeptKeepsItsEditAndRetriesIt() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.beforeSlotId = { WriteBacks.beforeSlotId = null; throw java.io.IOException("No space left on device") }
        save(provider, notes, "save the disk refused")
        assertNull(WriteBacks.pending(app, slot))
        val row = FailedTransfers.of(app).all().single()
        assertEquals("save the disk refused", File(row.file!!).readText())
        assertFalse(row.sourceGone())
        assertTrue(TransferQueue.retry(app, row))
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("save the disk refused", serverText(notes))
    }

    /*
     * A save that fails at each step of being kept in its slot (copying the edit, syncing it, writing its description,
     * publishing the record): its edit, or a generation the slot publishes, always survives, and the save lands in the end.
     * A failure to delete the edit after the save was kept leaves the save kept. Fails if any step can lose the edit
     * before the save is recoverable.
     */
    @Test
    fun aSaveFailingAtAnyStepOfBeingKeptIsNeverLost() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        for (step in listOf("copy", "fsync", "json", "record")) {
            val text = "save that failed at $step"
            WriteBacks.fault = { at -> if (at == step) { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
            save(provider, notes, text)
            val row = FailedTransfers.of(app).all().single()
            assertEquals("the edit was lost at $step", text, File(row.file!!).readText())
            TransferQueue.retry(app, row)
            assertEquals("not kept after $step", text, WriteBacks.contentOf(app, slot).readText())
            assertTrue(FailedTransfers.of(app).all().isEmpty())
            assertEquals(ListenableWorker.Result.success(), runSlot(slot))
            assertEquals(text, serverText(notes))
        }
        WriteBacks.fault = { at -> if (at == "delete") { WriteBacks.fault = null; throw java.io.IOException("The edit couldn't be deleted") } }
        save(provider, notes, "kept, its edit not deleted")
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertEquals("kept, its edit not deleted", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * A save couldn't be kept in its slot (its edit kept for a Retry); the other app then opens the file to read, and to
     * append: both start from that edit, the newest contents it saved, not the server's older version. Fails if an open
     * that keeps the contents skips an edit whose save couldn't be kept.
     */
    @Test
    fun anOpenAfterASaveCouldntBeKeptStartsFromIt() {
        val provider = provider()
        val notes = notes(provider)
        WriteBacks.fault = { at -> if (at == "json") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        save(provider, notes, "kept for a retry")
        assertEquals("kept for a retry", opened(provider, notes, "r"))
        assertEquals("kept for a retry", opened(provider, notes, "rw"))
    }

    /*
     * A save couldn't be kept in its slot; a newer save of the file is then kept, and the older one's Retry is pressed:
     * nothing older is kept over it (its row and edit go), and the newer lands. When the newer lands first, the older
     * row goes with that landing. Fails if a Retry of an older save can replace a newer one.
     */
    @Test
    fun aRetryOfAnOlderSaveNeverReplacesANewerOne() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.fault = { at -> if (at == "copy") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        save(provider, notes, "older save")
        val older = FailedTransfers.of(app).all().single()
        save(provider, notes, "newer save")
        assertFalse(TransferQueue.retry(app, older))
        assertEquals("newer save", WriteBacks.contentOf(app, slot).readText())
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertFalse(File(older.file!!).exists())
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("newer save", serverText(notes))
        // The same, the newer landing first: its landing retires the older row.
        WriteBacks.fault = { at -> if (at == "copy") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        save(provider, notes, "older again")
        val again = FailedTransfers.of(app).all().single()
        save(provider, notes, "newer again")
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertTrue("an older save's row outlived a newer landing", FailedTransfers.of(app).all().isEmpty())
        assertFalse(TransferQueue.retry(app, again))
        assertEquals("newer again", serverText(notes))
    }

    /*
     * Cancel pressed while a save's completion is in flight, and the rename after the completion fails: the upload landed
     * though the job ends stopped. Its landing is still recorded and its reservation settled. Fails if a stopped end is
     * taken over a landed one.
     */
    @Test
    fun aLandingAJobStoppedDuringIsNeverDiscarded() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "landed save")
        val job = jobs(slot).single()
        server.beforeAnswer = { method, path ->
            if (method == "POST" && path.endsWith("/complete")) {
                server.beforeAnswer = null
                TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:")).get(5, TimeUnit.SECONDS)
                server.extraRoutes = { m, segments, _, _ ->
                    if (m != "GET" && segments.size == 4 && segments[1] == "nodes" && segments[3] == "metadata") 500 to JSONObject().put("message", "The connection dropped") else null
                }
            }
        }
        runSlot(slot)
        server.extraRoutes = null
        assertNotNull("the landing wasn't recorded", WriteBacks.landing(app, slot))
        assertTrue(Reservations.all(app).none { WriteBacks.ledgerOf(slot, it.job) })
        assertEquals("landed save", serverText(notes))
    }

    /* Every closed edit on disk (filesDir/edits): what a save left that wasn't kept in its slot. */
    private fun closedEdits() = File(app.filesDir, WriteBacks.EDITS).walkTopDown().filter { it.isFile && it.name.endsWith(".closed") }.toList()

    /*
     * A save can't be kept in its slot and its row can't be written either (the same full disk): the closed edit stays on
     * disk, and the next start of the process finds it and gives it its row, whose Retry keeps and sends it. Fails if a
     * save whose row couldn't be written loses its edit.
     */
    @Test
    fun aSaveWhoseRowCantBeWrittenIsRecoveredAtTheNextStart() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.fault = { at -> if (at == "copy") throw java.io.IOException("No space left on device") }
        FailedTransfers.beforeWrite = { throw java.io.IOException("No space left on device") }
        save(provider, notes, "save on a full disk")
        WriteBacks.fault = null
        FailedTransfers.beforeWrite = null
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertEquals("save on a full disk", closedEdits().single().readText())
        TransferQueue.reconcileEdits(app, startup = true)
        val row = FailedTransfers.of(app).all().single()
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("save on a full disk", serverText(notes))
        assertTrue(closedEdits().isEmpty())
    }

    /*
     * A save that couldn't be kept waits more than a day for its Retry, and the process starts again (its cache swept of
     * copies over a day old): the edit is still there, and the Retry sends it. An edit opened and never closed, as old, is
     * an open no process holds any more and goes at that start. Fails if a retained edit is swept with the cache, or an
     * abandoned open is kept for ever.
     */
    @Test
    fun aRetainedEditOutlivesADayAndARestartWhileAnAbandonedOneGoes() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.fault = { at -> if (at == "copy") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        save(provider, notes, "kept over a day")
        val row = FailedTransfers.of(app).all().single()
        val abandoned = provider.personalEdit(vaultOf(provider), notes, "w").apply { writeText("never closed") }
        val twoDaysAgo = System.currentTimeMillis() - 2 * 86_400_000L
        File(app.filesDir, WriteBacks.EDITS).walkTopDown().forEach { it.setLastModified(twoDaysAgo) }
        com.hushos.app.data.DecryptedCopies.sweep(app.cacheDir)
        TransferQueue.reconcileEdits(app, startup = true)
        assertFalse("an abandoned open was kept", abandoned.exists())
        assertEquals("kept over a day", File(row.file!!).readText())
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("kept over a day", serverText(notes))
    }

    /*
     * The disk refuses every record of the file's slot for a while: each close still gets its number (reserving only reads)
     * and its closed edit and row, and nothing escapes the close thread. Once the disk takes writes again, the newest save
     * lands. Fails if reserving a number tries to publish (and throws), leaving the latest save without a row.
     */
    @Test
    fun savesWhileTheRecordCantBePublishedEachKeepTheirEdit() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.fault = { at -> if (at == "record") throw java.io.IOException("No space left on device") }
        save(provider, notes, "first save")
        save(provider, notes, "second save")
        WriteBacks.fault = null
        val rows = FailedTransfers.of(app).all()
        assertEquals(2, rows.size)
        assertEquals(setOf("first save", "second save"), rows.map { File(it.file!!).readText() }.toSet())
        rows.sortedByDescending { WriteBacks.stagedNumber(it.stage!!) }.forEach { TransferQueue.retry(app, it) }
        assertEquals(ListenableWorker.Result.success(), runSlot(slot))
        assertEquals("second save", serverText(notes))
    }

    /*
     * A save couldn't be kept (its row and edit retained); a newer save is kept, then cancelled. The cancel takes the older
     * retained save with it: its row and edit go, reads go back to the server's version, and its Retry keeps nothing, even
     * after the slot is gone. A save made after the cancel is kept. Fails if a cancel leaves an older save it covers to
     * be read or sent.
     */
    @Test
    fun aCancelTakesTheRetainedSavesItCovers() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        WriteBacks.fault = { at -> if (at == "copy") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        save(provider, notes, "older, retained")
        val retained = FailedTransfers.of(app).all().single()
        save(provider, notes, "newer, cancelled")
        val job = jobs(slot).single { !it.state.isFinished }
        TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:")).get(5, TimeUnit.SECONDS)
        assertTrue(FailedTransfers.of(app).all().isEmpty())
        assertFalse(File(retained.file!!).exists())
        assertEquals("original", opened(provider, notes, "r"))
        assertFalse(TransferQueue.retry(app, retained))
        save(provider, notes, "after the cancel")
        assertEquals("after the cancel", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * A save kept while its file's running job is about to fail for good, after the job's last look at the slot: the
     * save's own job is untouched by that failure (WorkManager runs both here, on a thread of its own) and lands it, with
     * no transfers panel and no sweep. Fails if a newer save's job is chained behind a running one, which WorkManager
     * fails with it.
     */
    @Test
    fun aNewerSaveKeptAsItsPredecessorFailsIsStillSentWithoutThePanel() {
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(java.util.concurrent.Executors.newSingleThreadExecutor()).build())
        val driver = WorkManagerTestInitHelper.getTestDriver(app)!!
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        save(provider, notes, "refused save")
        val failing = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        refuseBegins(true)
        TransferQueue.beforeSlotFails = {
            TransferQueue.beforeSlotFails = null
            refuseBegins(false)
            WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "behind").apply { writeText("newer save") })
            TransferQueue.enqueueSlot(app, slot, "Notes.txt")
        }
        fun finished(id: java.util.UUID): WorkInfo {
            val until = System.currentTimeMillis() + 30_000
            while (true) {
                val info = WorkManager.getInstance(app).getWorkInfoById(id).get()!!
                if (info.state.isFinished || System.currentTimeMillis() > until) return info
                Thread.sleep(50)
            }
        }
        driver.setAllConstraintsMet(failing.id)
        assertEquals(WorkInfo.State.FAILED, finished(failing.id).state)
        val next = jobs(slot).single { it.id != failing.id }
        assertEquals("the newer save's job went down with its predecessor", WorkInfo.State.ENQUEUED, next.state)
        driver.setAllConstraintsMet(next.id)
        assertEquals(WorkInfo.State.SUCCEEDED, finished(next.id).state)
        assertEquals("newer save", serverText(notes))
    }

    /*
     * Signing out takes the pending save with it (the account's queue), and a save the sign-out overtook (made under the
     * account that left) writes nothing back. Fails if a pending save, or one racing the sign-out, outlives it.
     */
    @Test
    fun signingOutTakesThePendingSavesAndKeepsNoneThatRaceIt() {
        val provider = provider()
        val notes = notes(provider)
        val slot = slotOf(provider, notes)
        val vault = vaultOf(provider)
        val opened = vault.resolve(notes)
        save(provider, notes, "pending at sign-out")
        AccountStore.of(app).wipe()
        assertFalse(WriteBacks.dir(app, slot).exists())
        val late = File(app.cacheDir, "late").apply { writeText("after the sign-out") }
        provider.onEditClosed(null, vault, late, opened)
        assertFalse("a save racing the sign-out wrote a slot back", WriteBacks.dir(app, slot).exists())
        assertFalse(late.exists())
    }
}
