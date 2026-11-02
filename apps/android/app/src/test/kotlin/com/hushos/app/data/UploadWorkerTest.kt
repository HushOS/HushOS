package com.hushos.app.data

import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

/*
 * The upload worker itself (UploadWorker, through WorkManager's test executor and driver) against FakeDrive with a family:
 * how a job starts (a landed row ends it before its file is looked at; an unreadable ledger retries), how it ends (landed is
 * a success; a removal ends the family's other jobs, then its own, settling through the ledger; a clean landing leaves no
 * landed row), and a Retry's real enqueue that takes the failed job's reservation over.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadWorkerTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "upload-worker-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build())
    }

    @After
    fun close() {
        File(app.filesDir, Reservations.FILE).setReadable(true)
        Reservations.forgetHeld()
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private val familyOf get() = TransferQueue.Family(family.groupId, family.workspaceId)

    /* A queued upload's copy, where TransferQueue.upload moves it: its job's own folder in the queue. */
    private fun staged(id: UUID): File = File(app.filesDir, "queue/$id/content").apply { parentFile!!.mkdirs(); writeText("packing list") }

    /* The job as WorkManager would start it: its id, input and tags from the request TransferQueue queues. */
    private fun worker(id: UUID, file: File): UploadWorker {
        val request = TransferQueue.uploadRequest(id, file, "text/plain", family.rootId, null, familyOf)
        JobNames.of(app).put(id.toString(), "Notes.txt")
        return TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
    }

    private fun run(worker: UploadWorker): ListenableWorker.Result = runBlocking { worker.doWork() }

    private fun records() = Reservations.all(app)
    private fun begins() = server.requests.count { it == "POST /api/drive/uploads" }

    /* The process killed mid-upload, as a test can: nothing after it runs. */
    private class Killed : Error()

    /* A run that died with its upload reserved, under `job`: its record is left on the ledger. */
    private fun leftReserved(job: UUID) {
        assertThrows(Killed::class.java) {
            FamilyUploads.upload(Vault.fromShared(app)!!, family.groupId, family.workspaceId, File(app.cacheDir, "k-$job").apply { writeText("packing list") },
                "Notes.txt", "text/plain", family.rootId, null, job.toString()) { throw Killed() }
        }
        assertEquals(1, records().count { it.job == job.toString() })
    }

    /* The completion's answer lost, then every later one answered 401 (the session gone): the job fails signed out. Undone by the returned call. */
    private fun completionLandsThenSignedOut(): () -> Unit {
        var lost = false
        server.dropReply = { method, path -> (method == "POST" && path.endsWith("/complete") && !lost).also { if (it) lost = true } }
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (lost && method == "POST" && segments.lastOrNull() == "complete") 401 to org.json.JSONObject().put("message", "Sign in")
            else inner(method, segments, query, body)
        }
        return { server.dropReply = null; server.extraRoutes = inner }
    }

    /*
     * A job whose upload landed in an earlier run (its landed row) ends as uploaded at its start, before its copy is
     * looked at: a copy gone meanwhile doesn't fail it. Fails if the worker's start skips the landed row.
     */
    @Test
    fun aLandedRowEndsTheJobAtItsStart() {
        val id = UUID.randomUUID()
        val file = staged(id)
        Reservations.reserved(app, "00000000-0000-4000-8000-0000000000bb", family.workspaceId, id.toString(), System.currentTimeMillis(), null)
        Reservations.idle("00000000-0000-4000-8000-0000000000bb")
        Reservations.completed(app, "00000000-0000-4000-8000-0000000000bb")
        assertTrue(Reservations.landed(app, id.toString()))
        file.delete()
        assertEquals(ListenableWorker.Result.success(), run(worker(id, file)))
        assertEquals(0, begins())
        assertEquals("the landed row outlived the job's end", emptyList<Reservations.Record>(), records())
    }

    /*
     * The ledger is there but can't be read when the job starts: it runs again later, reserving nothing, and the ledger is
     * intact. Fails if the start's read throws out of the worker or a begin goes out.
     */
    @Test
    fun anUnreadableLedgerAtTheStartRetries() {
        val id = UUID.randomUUID()
        leftReserved(UUID.randomUUID())
        val kept = records()
        val reserved = begins()
        assertTrue(File(app.filesDir, Reservations.FILE).setReadable(false))
        val result = run(worker(id, staged(id)))
        File(app.filesDir, Reservations.FILE).setReadable(true)
        assertEquals(ListenableWorker.Result.retry(), result)
        assertEquals(reserved, begins())
        assertEquals(kept, records())
    }

    /*
     * The completion lands and its answer is lost: the run is the network's (retry), its record kept. The next run's sweep
     * hears "already finished" and the job ends as uploaded: a success, nothing sent again, its copy and rows gone. Fails
     * if a landed upload ends as a failure.
     */
    @Test
    fun aCompletionWhoseAnswerWasLostEndsAsASuccessOnTheNextRun() {
        val id = UUID.randomUUID()
        val file = staged(id)
        server.dropReply = { method, path -> method == "POST" && path.endsWith("/complete") }
        assertEquals(ListenableWorker.Result.retry(), run(worker(id, file)))
        server.dropReply = null
        assertEquals(1, records().count { it.job == id.toString() })
        val reserved = begins()
        assertEquals(ListenableWorker.Result.success(), run(worker(id, file)))
        assertEquals("a landed upload was sent again", reserved, begins())
        assertEquals(emptyList<Reservations.Record>(), records())
        assertFalse(file.parentFile!!.exists())
    }

    /*
     * The family removed this account while a job had an upload reserved (its abort unanswered by the run's first sweep).
     * The job ends the family's other queued uploads (cancelled, said), then its own: its reservation settled through the
     * ledger, its copy gone, the removal said. Fails if either end is skipped.
     */
    @Test
    fun aRemovalEndsTheFamilysOtherJobsThenItsOwn() {
        val other = TransferQueue.upload(app, File(app.cacheDir, "other.txt").apply { writeText("menu") }, "Menu.txt", "text/plain", family.rootId, null, familyOf)
        val id = UUID.randomUUID()
        val file = staged(id)
        leftReserved(id)
        var drop = true
        server.beforeAnswer = { _, path -> if (drop && path.endsWith("/abort")) { drop = false; throw java.io.IOException("dropped") } }
        family.listed = false
        family.notMember = true
        val told = FailedTransfers.changes.value
        val result = run(worker(id, file))
        assertTrue("a job's end of the family didn't tell the panel", FailedTransfers.changes.value > told)
        assertTrue("a removal wasn't a failure: $result", result is ListenableWorker.Result.Failure)
        assertEquals(FamilyWords.NOT_IN_FAMILY, result.outputData.getString("message"))
        assertEquals("the job's own reservation wasn't settled", emptyList<Reservations.Record>(), records())
        assertFalse("the job's own copy was kept", file.parentFile!!.exists())
        assertEquals(WorkInfo.State.CANCELLED, WorkManager.getInstance(app).getWorkInfoById(other).get()!!.state)
        assertEquals(FamilyWords.NOT_IN_FAMILY, FailedTransfers.of(app).all().single { it.id == other.toString() }.reason)
    }

    /* A clean landing: a success, and the landed row its completion wrote is gone. Fails if the job's end leaves it. */
    @Test
    fun aCleanLandingLeavesNoLandedRow() {
        val id = UUID.randomUUID()
        assertEquals(ListenableWorker.Result.success(), run(worker(id, staged(id))))
        assertEquals(1, begins())
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * Retry's real enqueue: the completion lands, its answer is lost, then the session is gone (401) and the job fails.
     * Retry queues a new job in WorkManager that has taken the failed job's reservation over; run there, it ends as
     * uploaded and sends nothing again. Fails if the queued job doesn't own the reservation.
     */
    @Test
    fun aRetryQueuesAJobThatOwnsTheFailedJobsReservation() {
        val id = UUID.randomUUID()
        val signIn = completionLandsThenSignedOut()
        val failedResult = run(worker(id, staged(id)))
        assertTrue("a signed-out completion didn't fail the job: $failedResult", failedResult is ListenableWorker.Result.Failure)
        val failed = FailedTransfers.of(app).all().single { it.id == id.toString() }
        signIn()
        assertTrue(TransferQueue.retry(app, failed))
        assertTrue(FailedTransfers.of(app).all().none { it.id == id.toString() })
        val queued = WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get().single { it.id != id && !it.state.isFinished }.id
        // The reservation stays under the failed job's key, which the queued job carries.
        assertEquals(listOf(id.toString()), records().map { it.job })
        // Run as WorkManager would start it: the request Retry queued (its tags as stored), the failed job's copy and folder.
        val expected = TransferQueue.uploadRequest(queued, File(failed.file!!), failed.mime, failed.folder!!, failed.replacing, familyOf, failed.ledgerKey,
            TransferQueue.sessionTag(Shared.session(app)!!))
        assertEquals(expected.tags, WorkManager.getInstance(app).getWorkInfoById(queued).get()!!.tags)
        val retried = TestListenableWorkerBuilder<UploadWorker>(app).setId(queued).setInputData(expected.workSpec.input).setTags(expected.tags.toList()).build()
        val reserved = begins()
        assertEquals(ListenableWorker.Result.success(), run(retried))
        assertEquals("a retried upload that had landed was sent again", reserved, begins())
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /* What the panel reads when it is told the rows changed: the list as it is at that moment. */
    private fun readWhenTold(): () -> List<FailedTransfer>? {
        var seen: List<FailedTransfer>? = null
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined).launch {
            FailedTransfers.changes.drop(1).first()
            seen = FailedTransfers.of(app).all()
        }
        return { seen }
    }

    /*
     * #251 review 9: a family whose only uploads had failed already (their WorkManager jobs pruned) ends. Their copies go
     * and their rows say the removal, and the panel is told after the rows are written, so it never keeps the old reason
     * or a Retry with nothing behind it. Fails if the end doesn't tell the panel, or tells it before the rows changed.
     */
    @Test
    fun aFamilyWhoseUploadsHadFailedTellsThePanelOnceItsRowsChanged() {
        val id = UUID.randomUUID()
        val copy = staged(id)
        FailedTransfers.of(app).record(FailedTransfer(id.toString(), TransferQueue.UPLOAD, "Notes.txt", "The transfer failed.", 0L, file = copy.path,
            mime = "text/plain", folder = family.rootId, family = family.groupId.lowercase(), familyWorkspace = family.workspaceId))
        val seen = readWhenTold()
        TransferQueue.endFamily(app, family.groupId, Shared.session(app)!!) { _, _ -> Reservations.Abort.RELEASED }
        val told = seen()
        assertNotNull("the panel wasn't told the family's rows changed", told)
        val row = told!!.single { it.id == id.toString() }
        assertEquals(FamilyWords.NOT_IN_FAMILY, row.reason)
        assertEquals(null, row.file)
        assertFalse(copy.parentFile!!.exists())
    }

    /*
     * #251 review 9: a queued family upload ends; by the time its job is cancelled (what WorkManager tells the panel), its
     * row already says the removal. Fails if a cancellation can be seen before its row is written.
     */
    @Test
    fun aQueuedFamilyUploadsRowIsWrittenBeforeItsJobIsCancelled() {
        val other = TransferQueue.upload(app, File(app.cacheDir, "other.txt").apply { writeText("menu") }, "Menu.txt", "text/plain", family.rootId, null, familyOf)
        Reservations.reserved(app, "00000000-0000-4000-8000-0000000000cc", family.workspaceId, other.toString(), System.currentTimeMillis(), null)
        Reservations.idle("00000000-0000-4000-8000-0000000000cc")
        var cancelledWithoutRow = false
        var cancelled = 0
        TransferQueue.endFamily(app, family.groupId, Shared.session(app)!!, null, { true }, { _, _ -> Reservations.Abort.RELEASED }) { id ->
            cancelled++
            if (FailedTransfers.of(app).all().none { it.id == id.toString() && it.reason == FamilyWords.NOT_IN_FAMILY }) cancelledWithoutRow = true
            WorkManager.getInstance(app).cancelWorkById(id)
        }
        assertEquals(1, cancelled)
        assertFalse("a job was cancelled before its row said why", cancelledWithoutRow)
        assertEquals(WorkInfo.State.CANCELLED, WorkManager.getInstance(app).getWorkInfoById(other).get()!!.state)
    }

    /* A job as WorkManager starts the one a Retry queued: the request it built (checked against the tags it stored). */
    private fun queuedRetry(queued: UUID, failed: FailedTransfer): UploadWorker {
        val expected = TransferQueue.uploadRequest(queued, File(failed.file!!), failed.mime, failed.folder!!, failed.replacing, familyOf, failed.ledgerKey,
            TransferQueue.sessionTag(Shared.session(app)!!))
        assertEquals(expected.tags, WorkManager.getInstance(app).getWorkInfoById(queued).get()!!.tags)
        return TestListenableWorkerBuilder<UploadWorker>(app).setId(queued).setInputData(expected.workSpec.input).setTags(expected.tags.toList()).build()
    }

    /*
     * #251 review 10, item 1: the process dies in a Retry before its job was queued. The row is still there; the next
     * Retry's job holds the failed job's reservation all the same, and ends as uploaded without sending the file again.
     * Fails if a Retry that died leaves the reservation where a later Retry doesn't look.
     */
    @Test
    fun aRetryThatDiedBeforeItWasQueuedIsRetriedWithoutSendingTwice() {
        val id = UUID.randomUUID()
        val signIn = completionLandsThenSignedOut()
        assertTrue(run(worker(id, staged(id))) is ListenableWorker.Result.Failure)
        signIn()
        val failed = FailedTransfers.of(app).all().single { it.id == id.toString() }
        assertThrows(Killed::class.java) { TransferQueue.retryUpload(failed) { _, _ -> throw Killed() } }
        assertTrue(FailedTransfers.of(app).has(id.toString()))
        assertTrue(TransferQueue.retry(app, failed))
        val queued = WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get().single { it.id != id && !it.state.isFinished }.id
        val reserved = begins()
        assertEquals(ListenableWorker.Result.success(), run(queuedRetry(queued, failed)))
        assertEquals("a retried upload was sent twice", reserved, begins())
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review 10, item 2: a job ends as uploaded from its landed row (its completion's answer lost), and WorkManager
     * stops it during that end, so it runs again. The rerun ends as uploaded too, never "pick it again" for the copy the
     * first end deleted. Fails if that end deletes anything before the success is kept.
     */
    @Test
    fun aLandedEndStoppedPartWayStillEndsTheRerunAsUploaded() {
        val id = UUID.randomUUID()
        val file = staged(id)
        server.dropReply = { method, path -> method == "POST" && path.endsWith("/complete") }
        assertEquals(ListenableWorker.Result.retry(), run(worker(id, file)))
        server.dropReply = null
        assertEquals(ListenableWorker.Result.success(), run(worker(id, file)))
        val reserved = begins()
        assertEquals("a rerun after a stop didn't end as uploaded", ListenableWorker.Result.success(), run(worker(id, file)))
        assertEquals(reserved, begins())
    }

    /* As above for a clean landing: stopped during its end, the rerun ends as uploaded and sends nothing. */
    @Test
    fun aCleanLandingStoppedPartWayStillEndsTheRerunAsUploaded() {
        val id = UUID.randomUUID()
        val file = staged(id)
        assertEquals(ListenableWorker.Result.success(), run(worker(id, file)))
        assertEquals("a rerun after a stop didn't end as uploaded", ListenableWorker.Result.success(), run(worker(id, file)))
        assertEquals(1, begins())
    }

    /*
     * A retried job that fails again keeps the key it ran under on its row, so the next Retry still holds the first job's
     * reservation. Fails if a failed row drops the carried key.
     */
    @Test
    fun aFailedRetryKeepsTheFirstJobsKeyOnItsRow() {
        val first = UUID.randomUUID().toString()
        val id = UUID.randomUUID()
        val gone = File(app.filesDir, "queue/$id/content")
        val request = TransferQueue.uploadRequest(id, gone, "text/plain", family.rootId, null, familyOf, first)
        val result = runBlocking { TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build().doWork() }
        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(first, FailedTransfers.of(app).all().single { it.id == id.toString() }.ledgerKey)
    }

    /*
     * A family ends while a retried upload of it is queued: the reservation it holds under the first job's key is settled
     * through the ledger. Fails if endFamily looks under the queued job's own id.
     */
    @Test
    fun aFamilysEndSettlesAQueuedRetrysReservationUnderItsKey() {
        val first = UUID.randomUUID()
        leftReserved(first)
        val failed = FailedTransfer(first.toString(), TransferQueue.UPLOAD, "Notes.txt", "The transfer failed.", 0L,
            file = File(app.cacheDir, "retry.txt").apply { writeText("packing list") }.path, mime = "text/plain", folder = family.rootId,
            family = family.groupId.lowercase(), familyWorkspace = family.workspaceId)
        assertTrue(TransferQueue.retry(app, failed))
        TransferQueue.endFamily(app, family.groupId, Shared.session(app)!!) { uploadId, workspaceId -> Vault.fromShared(app)!!.api.abortUpload(uploadId, workspaceId) }
        assertEquals("a queued retry's reservation was left behind", emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 final round, item 2: a family upload's job failed and the app has no row of it, so the panel builds one from
     * what WorkManager kept. That row keeps its family, folder workspace and ledger key: its Retry opens the family, and a
     * removal of the family finds it. Fails if a rebuilt row loses its family.
     */
    @Test
    fun aRowRebuiltFromAFailedJobKeepsItsFamily() {
        val id = UUID.randomUUID()
        val request = TransferQueue.uploadRequest(id, File(app.filesDir, "queue/$id/content"), "text/plain", family.rootId, null, familyOf, "first")
        val result = runBlocking { TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build().doWork() }
        val output = (result as ListenableWorker.Result.Failure).outputData
        FailedTransfers.of(app).forget(id.toString())
        val rebuilt = FailedTransfer.fromWork(WorkInfo(id, WorkInfo.State.FAILED, request.tags, output), "Notes.txt")
        assertEquals(family.groupId.lowercase(), rebuilt.family)
        assertEquals(family.workspaceId.lowercase(), rebuilt.familyWorkspace)
        assertEquals("first", rebuilt.ledgerKey)
        FailedTransfers.of(app).record(rebuilt)
        TransferQueue.endFamily(app, family.groupId, Shared.session(app)!!) { _, _ -> Reservations.Abort.RELEASED }
        assertEquals("a removal missed the rebuilt row", FamilyWords.NOT_IN_FAMILY, FailedTransfers.of(app).all().single { it.id == id.toString() }.reason)
    }

    /*
     * #251 final round, item 3: an account's removal is still cleaning up (blocked on an abort) when another account signs
     * in and queues an upload into the same family, with a failed one of that family on its panel. The old cleanup stops:
     * the new account's upload stays queued and its row keeps its words and copy. Fails if a cleanup goes on once its
     * session is no longer the one signed in.
     */
    @Test
    fun aRemovalStillRunningWhenAnotherAccountSignsInLeavesItsUploadsAlone() {
        val first = Shared.session(app)!!
        val mine = TransferQueue.upload(app, File(app.cacheDir, "mine.txt").apply { writeText("menu") }, "Menu.txt", "text/plain", family.rootId, null, familyOf)
        Reservations.reserved(app, "00000000-0000-4000-8000-0000000000dd", family.workspaceId, mine.toString(), System.currentTimeMillis(), null)
        Reservations.idle("00000000-0000-4000-8000-0000000000dd")
        val inAbort = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val cleanup = Thread {
            TransferQueue.endFamily(app, family.groupId, first) { _, _ ->
                inAbort.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
                Reservations.Abort.RELEASED
            }
        }.apply { start() }
        assertTrue(inAbort.await(10, java.util.concurrent.TimeUnit.SECONDS))
        // Another account signs in and uses the same family.
        Shared.writeSession(app, Shared.Session(server.origin, "another-token", UUID.randomUUID().toString(), "sam@example.org"))
        val theirs = TransferQueue.upload(app, File(app.cacheDir, "theirs.txt").apply { writeText("plan") }, "Plan.txt", "text/plain", family.rootId, null, familyOf)
        val theirCopy = staged(UUID.randomUUID())
        val theirFailed = FailedTransfer(UUID.randomUUID().toString(), TransferQueue.UPLOAD, "Trip.txt", "The transfer failed.", 0L, file = theirCopy.path,
            mime = "text/plain", folder = family.rootId, family = family.groupId.lowercase(), familyWorkspace = family.workspaceId)
        FailedTransfers.of(app).record(theirFailed)
        release.countDown()
        cleanup.join(10_000)
        assertEquals(WorkInfo.State.ENQUEUED, WorkManager.getInstance(app).getWorkInfoById(theirs).get()!!.state)
        assertEquals("the old account's removal rewrote the new account's row", theirFailed, FailedTransfers.of(app).all().single { it.id == theirFailed.id })
        assertTrue("the old account's removal deleted the new account's copy", theirCopy.exists())
    }

    /*
     * As above, for a job another session queued (still in WorkManager): a removal ends only its own session's jobs. Fails
     * if a cleanup lists the family's jobs without their session.
     */
    @Test
    fun aRemovalEndsOnlyItsOwnSessionsJobs() {
        val first = Shared.session(app)!!
        Shared.writeSession(app, first.copy(token = "an-earlier-token"))
        val earlier = TransferQueue.upload(app, File(app.cacheDir, "earlier.txt").apply { writeText("plan") }, "Plan.txt", "text/plain", family.rootId, null, familyOf)
        Shared.writeSession(app, first)
        TransferQueue.endFamily(app, family.groupId, first) { _, _ -> Reservations.Abort.RELEASED }
        assertEquals(WorkInfo.State.ENQUEUED, WorkManager.getInstance(app).getWorkInfoById(earlier).get()!!.state)
    }

    /*
     * #251 final round, item 4: a retried upload (the first job's ledger key) meets a key change. Its wait is its own,
     * under the worker's id as the panel reads it, not the first job's long-expired one: it waits, then lands. Fails if
     * the wait is kept under the ledger key.
     */
    @Test
    fun aRetriedUploadsKeyChangeWaitIsItsOwn() {
        val worker = UUID.randomUUID().toString()
        val waits = KeyChangeWaits.of(app)
        waits.mark("first", 1L)
        var refused = false
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (!refused && method == "POST" && segments == listOf("drive", "uploads")) {
                refused = true
                409 to org.json.JSONObject().put("code", "rotating").put("message", "This folder’s keys are changing. Try again in a moment.")
            } else inner(method, segments, query, body)
        }
        val landed = TransferQueue.runUpload(app, Vault.fromShared(app)!!, "first", staged(UUID.randomUUID()), "Notes.txt", "text/plain", family.rootId, null,
            familyOf, waits, pause = {}, waiting = {}, progress = {}, waitKey = worker)
        assertNotNull(landed)
        assertTrue(refused)
        assertNotNull("the wait wasn't the job's own", waits.since(worker))
    }
}
