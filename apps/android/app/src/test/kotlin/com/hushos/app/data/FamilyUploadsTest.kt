package com.hushos.app.data

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
 * Queued uploads into family folders (FamilyUploads, as the transfer job runs them) through the real Vault, GroupsApi and
 * the core's area ledger against FakeDrive: a job's own vault, which holds no family, accepts the family itself, never
 * sweeps the app's family copies, and lands the file; a guard owed, a removal or the session ending while it is on its
 * way sends no completion and aborts the reserved upload; and a run after the process died aborts what the dead run left
 * reserved and opens the family again before it uploads.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyUploadsTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-uploads-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* A transfer job's vault (jobVault): the session's, a vault of its own with an empty ledger. */
    private fun job(): Vault = Vault.fromShared(app)!!

    private fun local(name: String, text: String) = File(app.cacheDir, "local-${System.nanoTime()}/$name").apply { parentFile!!.mkdirs(); writeText(text) }

    private fun upload(vault: Vault, job: String = UUID.randomUUID().toString(), progress: (Float) -> Unit = {}): Opened =
        FamilyUploads.upload(vault, family.groupId, family.workspaceId, local("Notes.txt", "packing list"), "Notes.txt", "text/plain", family.rootId, null, job, progress)

    private fun records() = Reservations.all(app)
    private fun begins() = server.requests.count { it == "POST /api/drive/uploads" }

    private fun accepted(phone: FamilyFixture.Phone) =
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)

    private fun aborted() = server.requests.filter { it.startsWith("POST ") && it.endsWith("/abort") }
    private fun completed() = server.requests.filter { it.endsWith("/complete") }

    /*
     * The app isn't running: a job's vault accepts the family on its own, lists the folder through its ledger and lands the
     * file, which another phone of the account reads. The app's copies of another family's folder, opened before, are
     * still there: a job's acceptance never sweeps. Fails if the job doesn't open the family itself, or if its sync sweeps.
     */
    @Test
    fun aJobOpensTheFamilyItselfLandsTheFileAndSweepsNothing() {
        val other = File(FamilyCopies.folder(app.cacheDir, UUID.randomUUID().toString())!!, "a/v/Photo.jpg").apply { parentFile!!.mkdirs(); writeText("the app's copy") }
        val landed = upload(job())
        assertTrue("a job's family sync swept the app's family copies", other.exists())
        val reader = family.phone()
        accepted(reader)
        val row = reader.vault.listChildren(family.rootId, family.workspaceId).single { it.id == landed.id }
        val out = File(app.cacheDir, "read-${System.nanoTime()}/Notes.txt")
        reader.vault.download(row.id, out, workspaceId = family.workspaceId)
        assertEquals("packing list", out.readText())
    }

    /*
     * The family's guard becomes owed while the job's upload is on its way (a sync elsewhere that couldn't store it): the
     * completion isn't sent and the reserved upload is aborted; its record goes once an abort is answered. Fails if a refused
     * completion leaves its room reserved.
     */
    @Test
    fun aGuardOwedMidJobAbortsTheUploadAndSendsNoCompletion() {
        val vault = job()
        vault.beforeWriteGate = { if ("POST /api/drive/uploads" in server.requests) vault.oweFamilyGuard(family.groupId) }
        assertThrows(GuardUnsaved::class.java) { upload(vault) }
        assertEquals(1, aborted().size)
        assertEquals(emptyList<String>(), completed())
        // Its abort was answered: the reservation is settled and off the ledger.
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * The family removes this account while the job's upload is on its way; the app's sync hears not-member and lets the
     * family go (in the session's state the job shares). The job sends no completion, aborts the reserved upload, and says
     * the removal, so the queue ends the family's uploads. Fails if a job's completion goes out after its folder was let go.
     */
    @Test
    fun aRemovalMidJobSendsNoCompletionAndSaysTheRemoval() {
        val appPhone = family.phone()
        accepted(appPhone)
        val vault = job()
        vault.beforeWriteGate = {
            if ("POST /api/drive/uploads" in server.requests && family.notMember.not()) {
                family.notMember = true
                assertEquals(FamilyState.Wiped, appPhone.sync.sync(family.summary))
            }
        }
        val error = runCatching { upload(vault) }.exceptionOrNull()
        assertTrue("a removal mid-job wasn't said as one: $error", error != null && FamilyUploads.removed(error))
        assertEquals(emptyList<String>(), completed())
        assertEquals(1, aborted().size)
    }

    /*
     * The account signs out while the job's upload is on its way (the app closes the session): the job sends no
     * completion and aborts the reserved upload. Fails if a closed session's job completes its upload.
     */
    @Test
    fun theSessionEndingMidJobSendsNoCompletion() {
        val appPhone = family.phone()
        accepted(appPhone)
        val vault = job()
        vault.beforeWriteGate = { if ("POST /api/drive/uploads" in server.requests) appPhone.vault.close() }
        assertThrows(SessionEnded::class.java) { upload(vault) }
        assertEquals(emptyList<String>(), completed())
        assertEquals(1, aborted().size)
    }

    /* The process killed mid-upload, as a test can: nothing after it runs (no catch, no abort). */
    private class Killed : Error()

    /*
     * The process dies after the job's upload was reserved and a part went up. The next run (a new process: a fresh
     * session state and vault, nothing of the family open) aborts what the dead run left reserved, accepts the family
     * again and lands the file once. Fails if a resumed run leaves the old reservation, or uploads without opening the
     * family first.
     */
    @Test
    fun aRunAfterTheProcessDiedAbortsTheLeftoverAndOpensTheFamilyAgain() {
        val job = UUID.randomUUID().toString()
        val first = job()
        assertThrows(Killed::class.java) { upload(first, job) { throw Killed() } }
        val leftover = records().single { it.job == job }.uploadId
        assertEquals(emptyList<String>(), aborted())
        // A new process: the dead one's session state and ledger are gone; the reservations ledger is on disk.
        first.close()
        val second = job()
        assertTrue(second.familyAreas.isEmpty() || !second.areaLedger.isArea(family.workspaceId))
        val landed = upload(second, job)
        assertEquals(listOf("POST /api/drive/uploads/$leftover/abort"), aborted())
        assertNotNull(landed)
        assertEquals(1, completed().size)
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review: the group routes drop (a timeout, a lost connection) while the job opens the family, or route 2 skips
     * the family and route 5 then drops. The job stops as the network's, to run again, never failed for good. Fails if a
     * transient group answer fails the upload.
     */
    @Test
    fun aDroppedGroupRouteIsTheNetworksAndTheJobRunsAgain() {
        server.beforeAnswer = { _, path -> if (path.startsWith("groups")) throw java.io.IOException("dropped") }
        val dropped = runCatching { upload(job()) }.exceptionOrNull()
        assertTrue("a dropped route 2 failed the upload for good: $dropped", dropped != null && Resumable.retryable(dropped))
        family.listed = false
        server.beforeAnswer = { _, path -> if (path.contains("/rosters")) throw java.io.IOException("dropped") }
        val unlisted = runCatching { upload(job()) }.exceptionOrNull()
        server.beforeAnswer = null
        assertTrue("a family route 2 skipped, with no answer from route 5, failed the upload: $unlisted", unlisted != null && Resumable.retryable(unlisted))
        assertEquals(emptyList<String>(), server.requests.filter { it == "POST /api/drive/uploads" })
    }

    /*
     * #251 review: a run the process died in left a reservation, and the next run's abort gets no answer. The record is
     * kept, nothing new is reserved, and the run is the network's; once an abort is answered the record goes and the file
     * lands once. A record released for good (the row removed) is owed until a later job's abort is answered. Fails if
     * an unanswered abort forgets the reservation or a new one is made while it may still hold room.
     */
    @Test
    fun aReservationIsKeptUntilItsAbortIsAnswered() {
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        val leftover = records().single().uploadId
        val reserved = begins()
        server.beforeAnswer = { _, path -> if (path.endsWith("/abort")) throw java.io.IOException("dropped") }
        val unanswered = runCatching { upload(job(), job) }.exceptionOrNull()
        assertTrue("an unanswered abort wasn't the network's: $unanswered", unanswered is Unreachable)
        assertEquals("an unanswered abort forgot the reservation", listOf(leftover), records().map { it.uploadId })
        assertEquals("a new upload was reserved while an older one may hold room", reserved, begins())
        // The job ends for good (its row removed, a removal): its folder goes, the record stays on the ledger.
        TransferQueue.dropJob(app, job, null) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals(listOf(leftover), records().map { it.uploadId })
        server.beforeAnswer = null
        Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review: a key change the folder hasn't reached yet is looked at again every half minute, never further apart
     * however many looks it took, and half an hour after the wait began (a wait kept from an earlier run counting) the
     * upload gives up in iOS's words. Fails if the pauses grow or the give-up comes late.
     */
    @Test
    fun aKeyChangeIsLookedAtEveryHalfMinuteForHalfAnHour() {
        var clock = 1_000_000L
        var since: Long? = null
        val pauses = ArrayList<Long>()
        val pending = FamilyFailure(FamilyWords.keyChangeWords("This folder’s keys changed: the key change has not reached it yet."))
        val gaveUp = runCatching {
            FamilyUploads.waitingOutKeyChanges<Unit>({ since }, { since = it }, { clock }, { ms -> pauses.add(ms); clock += ms }, {}) { throw pending }
        }.exceptionOrNull()
        assertEquals(FamilyUploads.GAVE_UP, gaveUp?.message)
        assertEquals(List(60) { 30_000L }, pauses)
        // A wait carried from an earlier run: a minute is left, so two looks.
        pauses.clear()
        since = clock - FamilyUploads.GIVE_UP_MS + 60_000L
        assertEquals(FamilyUploads.GAVE_UP, runCatching {
            FamilyUploads.waitingOutKeyChanges<Unit>({ since }, { since = it }, { clock }, { ms -> pauses.add(ms); clock += ms }, {}) { throw pending }
        }.exceptionOrNull()?.message)
        assertEquals(listOf(30_000L, 30_000L), pauses)
        // The job's own upload: refused at its gate by the key change twice, then landed, each look opening the family.
        pauses.clear()
        since = null
        val vault = job()
        var refusals = 2
        vault.beforeWriteGate = { if (refusals > 0) { refusals--; throw pending } }
        val landed = FamilyUploads.waitingOutKeyChanges({ since }, { since = it }, { clock }, { ms -> pauses.add(ms); clock += ms }, {}) { upload(vault) }
        assertNotNull(landed)
        assertEquals(listOf(30_000L, 30_000L), pauses)
        assertEquals(1, completed().size)
    }

    /*
     * #251 review 2, 1: a server error (503) while the job's family sync reads the member list: the network's, so the job
     * runs again, never failed for good. Fails if a transient failure inside FamilySync.run loses its retryability.
     */
    @Test
    fun aServerErrorInsideTheFamilysSyncIsTheNetworks() {
        family.rostersFail = true
        val error = runCatching { upload(job()) }.exceptionOrNull()
        assertTrue("a 503 in the family's sync failed the upload for good: $error", error != null && Resumable.retryable(error))
        assertEquals(0, begins())
    }

    /*
     * #251 review 2, 2: a key change refuses the completion of the job's first look, and the abort of its reservation gets
     * no answer. The wait's next look never reserves over it: it stops as the network's with the record kept. Fails if a
     * key-change retry reserves again while the job's earlier reservation is unsettled.
     */
    @Test
    fun aKeyChangeLookNeverReservesOverAnUnsettledReservation() {
        val vault = job()
        val job = UUID.randomUUID().toString()
        val pending = FamilyFailure(FamilyWords.keyChangeWords("This folder’s keys changed: the key change has not reached it yet."))
        var thrown = 0
        vault.beforeWriteGate = { if (thrown == 0 && "POST /api/drive/uploads" in server.requests) { thrown++; throw pending } }
        server.beforeAnswer = { _, path -> if (path.endsWith("/abort")) throw java.io.IOException("dropped") }
        var since: Long? = null
        var clock = 0L
        val pauses = ArrayList<Long>()
        val error = runCatching {
            FamilyUploads.waitingOutKeyChanges({ since }, { since = it }, { clock }, { ms -> pauses.add(ms); clock += ms }, {}) { upload(vault, job) }
        }.exceptionOrNull()
        server.beforeAnswer = null
        assertTrue("the wait went on past an unsettled reservation: $error", error is Unreachable)
        assertEquals("a look reserved again over an unsettled reservation", 1, begins())
        assertEquals(1, records().count { it.job == job })
        assertEquals(listOf(30_000L), pauses)
    }

    /*
     * #251 review 2, 4: the abort of a leftover reservation is answered 409 "finishing" (the server keeps its bytes
     * reserved while it completes): the record stays and nothing new is reserved. Answered 409 "already finished", the
     * upload completed after all: the record goes and the job is done, never sent again. Fails if a completing upload's
     * abort counts as settled, or a finished one is uploaded twice.
     */
    @Test
    fun anAbortAnsweredFinishingKeepsItsRecordAndFinishedEndsTheJob() {
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        val leftover = records().single().uploadId
        val inner = server.extraRoutes!!
        var answer = "This upload is finishing and cannot be cancelled."
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments.lastOrNull() == "abort") 409 to org.json.JSONObject().put("code", "conflict").put("message", answer)
            else inner(method, segments, query, body)
        }
        val reserved = begins()
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Unreachable)
        assertEquals("a completing upload's abort was counted as settled", listOf(leftover), records().map { it.uploadId })
        assertEquals(reserved, begins())
        answer = DriveApi.ALREADY_FINISHED
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Reservations.LandedEarlier)
        assertEquals(emptyList<Reservations.Record>(), records())
        assertEquals("a finished upload was sent again", reserved, begins())
    }

    /*
     * The ledger's one rule over every path: a landed upload's record goes; a failed one whose abort isn't answered keeps
     * its record through the job's drop (the worker's own end, a family's removal), a sweep that may not touch an upload
     * still running here, and a dead process, until an answered abort settles it. Fails if any path loses an unsettled
     * record or aborts a reservation still in use.
     */
    @Test
    fun theReservationLedgerLosesNoUnsettledRecordOnAnyPath() {
        val vault = job()
        upload(vault)
        assertEquals("a landed upload's record stayed", emptyList<Reservations.Record>(), records())
        val job = UUID.randomUUID().toString()
        server.beforeAnswer = { _, path -> if (path.endsWith("/abort")) throw java.io.IOException("dropped") }
        assertThrows(java.io.IOException::class.java) { upload(vault, job) { throw java.io.IOException("the network dropped mid-part") } }
        val failed = records().single { it.job == job }.uploadId
        TransferQueue.dropJob(app, job, null) { id, ws -> vault.api.abortUpload(id, ws) }
        assertEquals(listOf(failed), records().map { it.uploadId })
        // Another upload under way here: a sweep never aborts it, only once it stopped running.
        Reservations.reserved(app, "00000000-0000-4000-8000-0000000000aa", family.workspaceId, "other")
        server.beforeAnswer = null
        val asked = ArrayList<String>()
        Reservations.settleAll(app) { id, ws -> asked.add(id); vault.api.abortUpload(id, ws) }
        assertEquals(listOf(failed), asked)
        assertEquals(listOf("00000000-0000-4000-8000-0000000000aa"), records().map { it.uploadId })
        Reservations.idle("00000000-0000-4000-8000-0000000000aa")
        Reservations.settleAll(app) { id, ws -> vault.api.abortUpload(id, ws) }
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * What waits out a key change and what fails: the ledger's key-change refusal (said or raw), and the server's
     * `rotating`; its `stale` only once the upload has waited (a walk reaching the folder between a look and a begin), and
     * never a removal or another refusal. Fails if a key change fails the upload or a refusal is retried for half an hour.
     */
    @Test
    fun aKeyChangeWaitsAndARefusalDoesNot() {
        val pending = "This folder’s keys changed: the key change has not reached it yet."
        assertTrue(FamilyUploads.waits(FamilyFailure(FamilyWords.keyChangeWords(pending)), waited = false))
        assertTrue(FamilyUploads.waits(ApiError(409, "Keys are being rotated for this folder. Try again in a moment.", "rotating"), waited = false))
        assertFalse(FamilyUploads.waits(ApiError(409, "This item changed since you last saw it.", "stale"), waited = false))
        assertTrue(FamilyUploads.waits(ApiError(409, "This item changed since you last saw it.", "stale"), waited = true))
        assertFalse(FamilyUploads.waits(FamilyFailure.notInFamily, waited = true))
        assertFalse(FamilyUploads.waits(FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS), waited = true))
        assertFalse(FamilyUploads.waits(ApiError(409, "conflict", "conflict"), waited = true))
    }
}
