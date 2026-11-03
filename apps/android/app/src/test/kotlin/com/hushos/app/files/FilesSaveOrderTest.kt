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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        shadowOf(Looper.getMainLooper()).idle()
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
    private fun jobs(slot: String): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosForUniqueWork(slot).get()

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
        TransferQueue.cancel(app, first.id, WriteBacks.contentOf(app, slot).path)
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
        TransferQueue.cancel(app, jobs(slot).last().id, WriteBacks.contentOf(app, slot).path)
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
