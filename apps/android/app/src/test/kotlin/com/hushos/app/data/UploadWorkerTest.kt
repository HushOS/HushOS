package com.hushos.app.data

import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        val result = run(worker(id, file))
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
        assertEquals(listOf(queued.toString()), records().map { it.job })
        // Run as WorkManager would start it: the request Retry queued (its tags as stored), the failed job's copy and folder.
        val expected = TransferQueue.uploadRequest(queued, File(failed.file!!), failed.mime, failed.folder!!, failed.replacing, familyOf)
        assertEquals(expected.tags, WorkManager.getInstance(app).getWorkInfoById(queued).get()!!.tags)
        val retried = TestListenableWorkerBuilder<UploadWorker>(app).setId(queued).setInputData(expected.workSpec.input).setTags(expected.tags.toList()).build()
        val reserved = begins()
        assertEquals(ListenableWorker.Result.success(), run(retried))
        assertEquals("a retried upload that had landed was sent again", reserved, begins())
        assertEquals(emptyList<Reservations.Record>(), records())
    }
}
