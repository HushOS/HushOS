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
        Reservations.now = System::currentTimeMillis
        Reservations.forgetHeld()
        File(app.filesDir, Reservations.NEXT).delete()
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* A transfer job's vault (jobVault): the session's, a vault of its own with an empty ledger. */
    private fun job(): Vault = Vault.fromShared(app)!!

    private fun local(name: String, text: String) = File(app.cacheDir, "local-${System.nanoTime()}/$name").apply { parentFile!!.mkdirs(); writeText(text) }

    /* As the transfer job runs it: a job that lands forgets its landed row (the worker's Done). */
    private fun upload(vault: Vault, job: String = UUID.randomUUID().toString(), replacingId: String? = null, progress: (Float) -> Unit = {}): Opened =
        FamilyUploads.upload(vault, family.groupId, family.workspaceId, local("Notes.txt", "packing list"), "Notes.txt", "text/plain", family.rootId, replacingId, job, progress)
            .also { Reservations.forgetLanded(app, job) }

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
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Reservations.Landed)
        assertEquals("a finished upload was sent again", reserved, begins())
        // The reservation is settled; the job's landed row stays until the worker has ended it as uploaded.
        assertEquals(listOf(true), records().map { it.landed })
        Reservations.forgetLanded(app, job)
        assertEquals(emptyList<Reservations.Record>(), records())
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
        val running = "00000000-0000-4000-8000-0000000000aa"
        Reservations.reserved(app, running, family.workspaceId, "other", System.currentTimeMillis(), null)
        server.beforeAnswer = null
        val asked = ArrayList<String>()
        // The running upload is one the fake never began: its abort is answered as released here.
        val abort = { id: String, ws: String -> asked.add(id); if (id == running) Reservations.Abort.RELEASED else vault.api.abortUpload(id, ws) }
        Reservations.settleAll(app, abort)
        assertEquals(listOf(failed), asked)
        assertEquals(listOf(running), records().map { it.uploadId })
        Reservations.idle(running)
        Reservations.settleAll(app, abort)
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review 5, item 1: a completion lands but its answer is lost every time it is asked, and another worker's sweep
     * reaches the record first and hears "already finished". The job's next run ends as uploaded: no second begin, and one
     * file in the folder. Fails if a sweep's "completed" removes the record without keeping that the job landed.
     */
    @Test
    fun aCompletionWhoseAnswerWasLostEndsTheJobUploadedThoughAnotherSweepSettledIt() {
        val job = UUID.randomUUID().toString()
        val before = server.children(family.rootId).size
        server.dropReply = { method, path -> method == "POST" && path.endsWith("/complete") }
        val lost = runCatching { upload(job(), job) }.exceptionOrNull()
        server.dropReply = null
        assertTrue("a lost completion answer wasn't the network's: $lost", lost != null && Resumable.retryable(lost))
        assertEquals(1, records().count { it.job == job && !it.landed })
        Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
        assertTrue("the sweep's \"completed\" forgot that the job landed", Reservations.landed(app, job))
        val reserved = begins()
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Reservations.Landed)
        assertEquals("a landed file was sent again", reserved, begins())
        assertEquals("the folder holds the file twice", before + 1, server.children(family.rootId).size)
    }

    /*
     * #251 review 5, item 2: the server answers 404 (and 403) before it looks at an upload when this account can't reach
     * the workspace any more, so the reservation may still hold room. The record stays, and the job reserves nothing,
     * until the record's expiry (begin's, the later of the server's and the phone's) and the sweep's grace have passed.
     * Fails if a 404 or 403 settles a record early, or the server's later expiry is not kept.
     */
    @Test
    fun aNotFoundAbortKeepsTheRecordUntilItsExpiryHasPassed() {
        val expires = java.time.Instant.now().plusSeconds(48 * 3600)
        server.uploadExpiresAt = { expires }
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        val record = records().single()
        assertEquals("the server's later expiry wasn't kept", expires.toEpochMilli(), record.expiresAt)
        val inner = server.extraRoutes!!
        var status = 404
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments.lastOrNull() == "abort") status to org.json.JSONObject().put("message", "This upload no longer exists.")
            else inner(method, segments, query, body)
        }
        val reserved = begins()
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Unreachable)
        assertEquals("a 404 settled a reservation before its expiry", listOf(record.uploadId), records().map { it.uploadId })
        assertEquals(reserved, begins())
        status = 403
        Reservations.now = { record.expiresAt + Reservations.GRACE_MS - 1 }
        Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals("a 403 settled a reservation before the sweep surely ran", listOf(record.uploadId), records().map { it.uploadId })
        status = 404
        Reservations.now = { record.expiresAt + Reservations.GRACE_MS }
        Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review 5, item 3: the ledger can't be written after `begin` (a full disk). The reservation is aborted at once;
     * answered, the write's failure is the job's and nothing is held. Unanswered, the job is the network's, the record is
     * held in memory, and the job's next run reserves nothing while it is; a later sweep, the disk freed, settles it (it
     * isn't left marked running). Fails if a failed write leaves a reservation untracked, unaborted, or reserved over.
     */
    @Test
    fun aLedgerTheDiskRefusesStillAbortsAndIsNeverReservedOver() {
        val blocked = File(app.filesDir, Reservations.NEXT).apply { mkdirs() }
        val answered = runCatching { upload(job()) }.exceptionOrNull()
        assertTrue("a refused write wasn't said: $answered", answered is java.io.IOException && answered !is Unreachable)
        assertEquals(1, aborted().size)
        assertEquals(emptyList<Reservations.Record>(), records())
        val job = UUID.randomUUID().toString()
        server.beforeAnswer = { _, path -> if (path.endsWith("/abort")) throw java.io.IOException("dropped") }
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Unreachable)
        val held = records().single { it.job == job }.uploadId
        val reserved = begins()
        assertTrue(runCatching { upload(job(), job) }.exceptionOrNull() is Unreachable)
        assertEquals("a job reserved again over a reservation the disk refused", reserved, begins())
        assertTrue(blocked.delete())
        server.beforeAnswer = null
        Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals("a refused write left its reservation marked running", emptyList<Reservations.Record>(), records())
        assertTrue(aborted().contains("POST /api/drive/uploads/$held/abort"))
    }

    /* A family upload's `waitingOutKeyChanges` as the job runs it, on a clock that only the pauses move. */
    private fun <T> waitingOut(pauses: MutableList<Long>, attempt: () -> T): T {
        var since: Long? = null
        var clock = 0L
        return FamilyUploads.waitingOutKeyChanges({ since }, { since = it }, { clock }, { ms -> pauses.add(ms); clock += ms }, {}, attempt)
    }

    /* Answers the next requests matching `matches` with `answer` (`times` of them), the rest as the fake does. */
    private fun answering(times: Int, matches: (String, List<String>) -> Boolean, answer: () -> Pair<Int, org.json.JSONObject>) {
        val inner = server.extraRoutes!!
        var left = times
        server.extraRoutes = { method, segments, query, body ->
            if (left > 0 && matches(method, segments)) { left--; answer() } else inner(method, segments, query, body)
        }
    }

    /*
     * #251 review 6, item 1: a new version lands, then its name signed again (new size and date) meets a key change (409
     * `rotating`). The upload is landed: never sent again, inside the wait or by a run after the process died there. Fails
     * if anything after the completion restarts the upload.
     */
    @Test
    fun aLandedNewVersionIsNeverSentAgainWhenWhatFollowsItsCompletionFails() {
        val vault = job()
        val original = upload(vault)
        val job = UUID.randomUUID().toString()
        answering(1, { method, segments -> method != "GET" && segments.size >= 2 && segments[segments.size - 2] == original.id && segments.last() == "metadata" }) {
            409 to org.json.JSONObject().put("code", "rotating").put("message", "This folder’s keys are changing. Try again in a moment.")
        }
        val reserved = begins()
        val pauses = ArrayList<Long>()
        val error = runCatching { waitingOut(pauses) { upload(vault, job, original.id) } }.exceptionOrNull()
        assertTrue("a refused name after the completion wasn't landed: $error", error is Reservations.Landed)
        assertEquals("the landed version was uploaded again", reserved + 1, begins())
        assertEquals(emptyList<Long>(), pauses)
        // A process dying right after the completion: the job's next run ends as uploaded, sending nothing.
        assertTrue(Reservations.landed(app, job))
        assertTrue(runCatching { upload(job(), job, original.id) }.exceptionOrNull() is Reservations.Landed)
        assertEquals(reserved + 1, begins())
        assertEquals(2, completed().size)
    }

    /*
     * #251 review 6, item 2: a key change reaches the folder while the parts go up, and the server refuses the completion
     * as packages/drive/src/server.ts completeUpload does (409 `conflict`, `data.conflicted`). The upload is aborted, the
     * wait pauses once, and it is sealed afresh and lands. A new version whose file someone else changed meanwhile (the
     * server's current version isn't the one replaced) stays a conflict: no wait. Fails if the key change fails the upload,
     * or an ordinary conflict is waited out.
     */
    @Test
    fun aKeyChangeThatReachedTheFileWhileItWentUpIsWaitedOutAndSealedAfresh() {
        val vault = job()
        fun conflicted(current: Any) = 409 to org.json.JSONObject().put("code", "conflict").put("message", "This file changed while it was uploading.")
            .put("data", org.json.JSONObject().put("conflicted", true).put("currentVersionId", current))
        val completing = { method: String, segments: List<String> -> method == "POST" && segments.lastOrNull() == "complete" }
        answering(1, completing) { conflicted(org.json.JSONObject.NULL) }
        val pauses = ArrayList<Long>()
        val reserved = begins()
        val landed = waitingOut(pauses) { upload(vault) }
        assertNotNull(landed)
        assertEquals("the key change wasn't waited out", listOf(FamilyUploads.PAUSE_MS), pauses)
        assertEquals(reserved + 2, begins())
        assertEquals(1, aborted().size)
        assertEquals(emptyList<Reservations.Record>(), records())
        answering(1, completing) { conflicted(UUID.randomUUID().toString()) }
        val moved = runCatching { waitingOut(pauses) { upload(vault, replacingId = landed.id) } }.exceptionOrNull()
        assertTrue("someone else's newer version was waited out: $moved", moved is ApiError && moved !is KeyChangeConflict && moved.code == "conflict")
        assertEquals(listOf(FamilyUploads.PAUSE_MS), pauses)
    }

    /*
     * #251 review 6, item 3: the app's sync wiped the family, then the process died before the family's queued uploads
     * ended, so no device record is left and route 2 no longer lists it. The job asks route 5 about its family directly: a
     * dropped route is the network's, not-member ends the upload as a removal, and its reservation settles through the
     * ledger. Fails if such a job waits for ever.
     */
    @Test
    fun aQueuedFamilyWithNoRecordLeftIsAskedAboutDirectly() {
        val wiping = job()
        upload(wiping)
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        family.listed = false
        family.notMember = true
        wiping.jobFamilies.wipe(family.groupId)
        family.notMember = false
        family.rostersFail = true
        val dropped = runCatching { upload(job(), job) }.exceptionOrNull()
        assertTrue("a dropped route 5 wasn't the network's: $dropped", dropped is Unreachable)
        family.rostersFail = false
        family.notMember = true
        val removed = runCatching { upload(job(), job) }.exceptionOrNull()
        assertTrue("a family gone with no record left wasn't a removal: $removed", removed != null && FamilyUploads.removed(removed))
        TransferQueue.dropJob(app, job, null) { id, ws -> job().api.abortUpload(id, ws) }
        assertEquals(emptyList<Reservations.Record>(), records())
    }

    /*
     * #251 review 7, P1: two job vaults accept the family at once, each with its own sync and turns. One stores its guard
     * while the other's acceptance is still in flight, then the other's store fails. The write barrier stays up over the
     * family the whole time; once a stored guard covers what was left owed (the next acceptance), it comes down. Fails if
     * one acceptance discharges another's guard debt.
     */
    @Test
    fun oneJobsStoredGuardNeverDischargesAnothersDebt() {
        val first = job()
        val second = job()
        val inStore = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        var blocked = false
        second.familyGuardWrites = {
            if (!blocked) { blocked = true; inStore.countDown(); release.await(10, java.util.concurrent.TimeUnit.SECONDS) }
            false
        }
        val racing = Thread { runCatching { second.jobFamilies.sync(family.summary) } }.apply { start() }
        assertTrue("the second acceptance never reached its guard's store", inStore.await(10, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue(first.jobFamilies.sync(family.summary) is FamilyState.Accepted)
        val group = family.groupId.lowercase()
        assertTrue("one acceptance's stored guard discharged another's debt still in flight", group in first.familyGuardOwed)
        release.countDown()
        racing.join(10_000)
        assertTrue("a failed store's debt was lost", group in first.familyGuardOwed)
        assertThrows(GuardUnsaved::class.java) { first.requireGuardKept(family.workspaceId) }
        assertThrows(GuardUnsaved::class.java) { second.requireGuardKept(family.workspaceId) }
        // The guard stored covers what the failed store owed: the next acceptance brings the barrier down.
        second.familyGuardWrites = { true }
        assertTrue(second.jobFamilies.sync(family.summary) is FamilyState.Accepted)
        assertFalse("a covered debt kept the barrier up", group in first.familyGuardOwed)
    }

    /*
     * #251 review 7, P2: the ledger is there but can't be read. A job's run reserves nothing and is the network's, a sweep
     * writes nothing, and the records are all still there once it reads again. Fails if a read failure counts as an empty
     * ledger, which the next write would put over the real one.
     */
    @Test
    fun anUnreadableLedgerIsNeverWrittenOverAndNothingIsReserved() {
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        val kept = records()
        val ledger = File(app.filesDir, Reservations.FILE)
        assertTrue(ledger.setReadable(false))
        try {
            val reserved = begins()
            val error = runCatching { upload(job(), job) }.exceptionOrNull()
            assertTrue("an unreadable ledger wasn't the job's to retry: $error", error is Reservations.LedgerUnreadable && Resumable.retryable(error))
            assertEquals("a reservation was made over an unreadable ledger", reserved, begins())
            assertThrows(Reservations.LedgerUnreadable::class.java) { Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) } }
            assertEquals(emptyList<String>(), aborted())
        } finally {
            ledger.setReadable(true)
        }
        assertEquals("the ledger's records were written over", kept, records())
    }

    /*
     * #251 review 7, P2: a completion whose answer was lost, and before the job runs again its family folder goes (route 25
     * no longer lists it). The run's first sweep hears "already finished": the job ends as uploaded there, before the
     * family or the folder is looked at. Fails if a run goes on past a sweep that found its upload landed.
     */
    @Test
    fun aRunEndsAsUploadedRightAfterTheSweepFindsItLanded() {
        val job = UUID.randomUUID().toString()
        val waits = KeyChangeWaits.of(app)
        fun run() = TransferQueue.runUpload(app, job(), job, local("Notes.txt", "packing list"), "Notes.txt", "text/plain", family.rootId, null,
            TransferQueue.Family(family.groupId, family.workspaceId), waits, pause = {}, waiting = {}, progress = {})
        server.dropReply = { method, path -> method == "POST" && path.endsWith("/complete") }
        val lost = runCatching { run() }.exceptionOrNull()
        server.dropReply = null
        assertTrue("a lost completion answer wasn't the network's: $lost", lost != null && Resumable.retryable(lost))
        family.areaListed = false
        val reserved = begins()
        val rerun = runCatching { run() }.exceptionOrNull()
        assertTrue("a run went on past its landed upload: $rerun", rerun is Reservations.Landed)
        assertEquals(reserved, begins())
    }

    /*
     * #251 review 8, item 1: the completion lands, its answer is lost, the next completion is answered 401 and the job
     * fails, its record kept. Signed in again, Retry queues a new job: it takes over the failed job's record, so its first
     * sweep hears "already finished" and it ends as uploaded, sending nothing. Fails if a retry's new id leaves the failed
     * job's reservation or landed row behind.
     */
    @Test
    fun aRetriedUploadTakesOverItsReservationAndEndsAsUploaded() = retriedAfterALostCompletion(sweptFirst = false)

    /* As above, with another job's sweep reaching the failed job's record before the Retry: its landed row is taken over. */
    @Test
    fun aRetriedUploadTakesOverItsLandedRowAndEndsAsUploaded() = retriedAfterALostCompletion(sweptFirst = true)

    private fun retriedAfterALostCompletion(sweptFirst: Boolean) {
        val waits = KeyChangeWaits.of(app)
        val staged = local("Notes.txt", "packing list")
        fun run(job: String) = TransferQueue.runUpload(app, job(), job, staged, "Notes.txt", "text/plain", family.rootId, null,
            TransferQueue.Family(family.groupId, family.workspaceId), waits, pause = {}, waiting = {}, progress = {})
        var signedOut = false
        server.dropReply = { method, path -> (method == "POST" && path.endsWith("/complete") && !signedOut).also { if (it) signedOut = true } }
        answering(Int.MAX_VALUE, { method, segments -> signedOut && method == "POST" && segments.lastOrNull() == "complete" }) {
            401 to org.json.JSONObject().put("message", "Sign in")
        }
        val failedJob = UUID.randomUUID().toString()
        val ended = runCatching { run(failedJob) }.exceptionOrNull()
        assertTrue("the completion's 401 didn't end the job signed out: $ended", ended is NotAuthenticated)
        assertEquals(1, records().count { it.job == failedJob && !it.landed })
        // Signed in again; the row's Retry.
        server.dropReply = null
        signedOut = false
        if (sweptFirst) {
            Reservations.settleAll(app) { id, ws -> job().api.abortUpload(id, ws) }
            assertTrue(Reservations.landed(app, failedJob))
        }
        val failed = FailedTransfer(failedJob, TransferQueue.UPLOAD, "Notes.txt", "Sign in to HushOS to see your files.", 0L, file = staged.path,
            mime = "text/plain", folder = family.rootId, family = family.groupId, familyWorkspace = family.workspaceId)
        var queued: String? = null
        assertTrue(TransferQueue.retryUpload(app, failed) { id ->
            queued = id.toString()
            assertEquals("a retry was queued before it took over the failed job's reservation", 1, records().count { it.job == queued })
        })
        val reserved = begins()
        val rerun = runCatching { run(queued!!) }.exceptionOrNull()
        assertTrue("a retried upload that had landed wasn't ended as uploaded: $rerun", rerun is Reservations.Landed)
        assertEquals("a retried upload was sent again", reserved, begins())
    }

    /*
     * #251 review 8, item 2: an upload outside the queue (a share's upload, Files writing a file back: no job) over a ledger
     * that is there but can't be read. Nothing is reserved: no begin is sent. Fails if only a queued job reads the ledger
     * before its begin.
     */
    @Test
    fun anUploadOutsideTheQueueSendsNoBeginOverAnUnreadableLedger() {
        val job = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), job) { throw Killed() } }
        val vault = job()
        if (vault.item(server.root) == null) vault.resolve(server.root)
        val ledger = File(app.filesDir, Reservations.FILE)
        assertTrue(ledger.setReadable(false))
        try {
            val reserved = begins()
            val error = runCatching { vault.upload(local("Plan.txt", "itinerary"), "Plan.txt", "text/plain", server.root, null) }.exceptionOrNull()
            assertTrue("an unreadable ledger didn't stop the upload: $error", error is Reservations.LedgerUnreadable)
            assertEquals("a begin went out over an unreadable ledger", reserved, begins())
        } finally {
            ledger.setReadable(true)
        }
    }

    /*
     * #251 hole 1: a Retry whose new job couldn't be queued (WorkManager's database refusing it) gives the rows it took over
     * back to the failed job, whose row stays, so the next Retry takes them over again. Fails if they stay with an id no
     * job has.
     */
    @Test
    fun aRetryThatCouldNotBeQueuedGivesItsRowsBack() {
        val failedJob = UUID.randomUUID().toString()
        assertThrows(Killed::class.java) { upload(job(), failedJob) { throw Killed() } }
        val kept = records()
        val failed = FailedTransfer(failedJob, TransferQueue.UPLOAD, "Notes.txt", "The transfer failed.", 0L, file = local("Notes.txt", "packing list").path,
            mime = "text/plain", folder = family.rootId, family = family.groupId, familyWorkspace = family.workspaceId)
        assertThrows(IllegalStateException::class.java) { TransferQueue.retryUpload(app, failed) { throw IllegalStateException("not queued") } }
        assertEquals("a retry that wasn't queued kept the failed job's rows", kept, records())
    }

    /* A queued family upload as FamilyUploads runs it, its landed row left as the job leaves it. */
    private fun uploadAsQueued(vault: Vault, job: String): Opened =
        FamilyUploads.upload(vault, family.groupId, family.workspaceId, local("Notes.txt", "packing list"), "Notes.txt", "text/plain", family.rootId, null, job) {}

    /*
     * #251 hole 2: the account leaves the phone (AccountStore.wipe) after the server reserved the upload but before its
     * record is written. Nothing of it is written back: no ledger file is left. Fails if an upload still on its way after
     * the wipe writes its record.
     */
    @Test
    fun aWipeAfterTheBeginLeavesNoLedger() {
        val store = AccountStore(app.filesDir, app.cacheDir, app.noBackupFilesDir)
        server.dropReply = { method, path -> if (method == "POST" && path == "drive/uploads") store.wipe(); false }
        val error = runCatching { uploadAsQueued(job(), UUID.randomUUID().toString()) }.exceptionOrNull()
        server.dropReply = null
        assertTrue("an upload wiped after its begin went on: $error", error is SessionEnded)
        assertFalse("a ledger was written after the wipe", File(app.filesDir, Reservations.FILE).exists())
    }

    /* As above, the wipe landing between the completion and its landed row: no row is written back. */
    @Test
    fun aWipeAfterTheCompletionLeavesNoLedger() {
        val store = AccountStore(app.filesDir, app.cacheDir, app.noBackupFilesDir)
        server.dropReply = { method, path -> if (method == "POST" && path.endsWith("/complete")) store.wipe(); false }
        runCatching { uploadAsQueued(job(), UUID.randomUUID().toString()) }
        server.dropReply = null
        assertFalse("a landed row was written after the wipe", File(app.filesDir, Reservations.FILE).exists())
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
