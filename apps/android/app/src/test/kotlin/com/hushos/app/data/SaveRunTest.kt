package com.hushos.app.data

import android.content.Context
import com.hushos.core.Integrity
import com.hushos.core.NodeMetadata
import com.hushos.core.PlannedResult
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.deviceRemember
import com.hushos.core.randomBytes
import com.hushos.core.runEstimate
import com.hushos.core.signingPublicKey
import com.hushos.core.versionIntegrity
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/*
 * The save path on the phone (SaveRuns.kt). A run decides before anything is made whether it may write and whether it
 * fits, saves results from memory under the next free name, ends a version race `stale`, and leaves no new file behind when
 * it stops. Each test fails on the defect a person would see: a run that starts and fails halfway, a laundered mark, a
 * half-made result left behind, a file an editor may only trash deleted forever, a row the next open needs lost, a row
 * written after a sign-out.
 */
class SaveRunTest {
    private fun opened(id: String, parent: String? = "root", version: String? = null, keyEpoch: ULong = 1uL, name: String = id): Opened {
        val current = version?.let { VersionView(it, "o", "", "ready", 3u, 1, "n", null, null, null) }
        val node = NodeView(id, "ws", parent, if (version == null) "folder" else "file", keyEpoch, 1uL, "", 1uL, "", current, null, null, null)
        return Opened(node, NodeMetadata(name, null, null, null, emptyMap()))
    }

    /* A journal of its own session: another test's sign-out (AccountStoreTest wipes) never ends it. */
    private fun journal(epoch: SaveRunJournal.Epoch = SaveRunJournal.Epoch()) =
        SaveRunJournal(Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile(), epoch)
    private val own = SaveSources.OwnWriting

    /* The drive as a run's clean-up meets it: nodes live, in the Trash or deleted; uploads open or finished. */
    private class FakeWriter(var room: SaveRoom = SaveRoom.Own(1L shl 40)) : SaveRunWriter {
        var refusal: String? = null
        var names = listOf<String>()
        var member = true
        var offline = false
        var denied = false
        val refuse = HashSet<String>()
        val busy = HashSet<String>()
        val live = HashSet<String>()
        val trashed = HashSet<String>()
        val purged = HashSet<String>()
        val open = HashSet<String>()
        val finished = HashSet<String>()
        val aborted = ArrayList<String>()
        val uploads = ArrayList<Triple<String, Opened?, Prior?>>()
        val startedFrom = ArrayList<String?>()
        var fresh: ((Opened) -> Opened?)? = null
        var listing: (() -> Unit)? = null
        val answers = ArrayDeque<(Int) -> Unit>()
        /* The destination's key epoch each upload and folder was sealed under, and each folder refresh. */
        val folderEpochs = ArrayList<ULong>()
        var refreshes = 0
        val folderAnswers = ArrayDeque<() -> Unit>()
        var making: (() -> Unit)? = null
        var landing: (() -> Unit)? = null
        /* Runs before the begin's ids reach the run (a begin still on its way). */
        var beginning: (() -> Unit)? = null
        /* What each folder refresh does, in order (default: the folder at the next key epoch). */
        val refreshAnswers = ArrayDeque<() -> Unit>()
        /* Uploads the server is still completing: an abort is answered UNKNOWN (VaultSaveWriter.abortUpload after its tries). */
        val completing = HashSet<String>()
        var roomHook: (() -> Unit)? = null
        private var count = 0

        override fun refusal(target: Opened) = refusal
        override fun room(workspaceId: String): SaveRoom { roomHook?.invoke(); return room }
        override fun names(folder: Opened): List<String> { listing?.invoke(); return names }
        override fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened {
            folderEpochs += folder.node.keyEpoch
            folderAnswers.removeFirstOrNull()?.invoke()
            making?.invoke()
            live += "made-$name"
            return Opened(NodeView("made-$name", "ws", folder.id, "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()))
        }
        override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                                  thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit): Opened {
            val n = ++count
            uploads.add(Triple(name, replacing, copy))
            folderEpochs += folder.node.keyEpoch
            this.startedFrom.add(startedFrom)
            val nodeId = replacing?.id ?: "node-$n"
            open += "up-$n"
            beginning?.invoke()
            try {
                onBegun(Vault.BegunIds("ws", "up-$n", nodeId))
            } catch (error: Exception) {
                // As the vault does: nothing is sent, the reservation goes.
                open -= "up-$n"
                aborted += "up-$n"
                throw error
            }
            answers.removeFirstOrNull()?.invoke(n)
            landing?.invoke()
            open -= "up-$n"
            finished += "up-$n"
            if (replacing == null) live += nodeId
            return Opened(NodeView(nodeId, "ws", folder.id, "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()))
        }
        override fun fresh(file: Opened, folder: Opened): Opened? {
            val look = fresh ?: return file
            return look(file)
        }
        override fun refreshFolder(folder: Opened): Opened {
            refreshes++
            refreshAnswers.removeFirstOrNull()?.invoke()
            return Opened(folder.node.copy(keyEpoch = folder.node.keyEpoch + 1uL), folder.metadata)
        }
        override fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate {
            if (offline) return SaveAbortFate.UNKNOWN
            if (uploadId in completing) return SaveAbortFate.UNKNOWN
            aborted += uploadId
            if (uploadId in finished) return SaveAbortFate.FINISHED
            return if (open.remove(uploadId)) SaveAbortFate.ABORTED else SaveAbortFate.GONE
        }
        override fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> {
            if (offline) throw Unreachable()
            return ids.associateWith { id ->
                when {
                    denied -> SaveItemFate.DENIED
                    id in refuse -> SaveItemFate.REFUSED
                    live.remove(id) -> { trashed += id; SaveItemFate.DONE }
                    id in trashed -> SaveItemFate.DONE
                    else -> SaveItemFate.GONE
                }
            }
        }
        override fun purge(ids: List<String>, workspaceId: String) = ids.associateWith { id ->
            when {
                id in busy -> SaveItemFate.REFUSED
                trashed.remove(id) -> { purged += id; SaveItemFate.DONE }
                else -> SaveItemFate.GONE
            }
        }
        override fun mayPurge(workspaceId: String) = member
    }

    @Test
    fun aReadOnlyFamilyFolderRefusesTheRunBeforeAnythingIsMade() {
        val writer = FakeWriter().apply { refusal = FamilyWords.UNAVAILABLE }
        val rows = journal()
        val refused = assertThrows(SaveRefused::class.java) { SaveRun.start(writer, listOf(opened("fam")), listOf(PlannedResult.Known(1uL, true)), rows) }
        assertEquals(SaveRefused.Reason.READ_ONLY, refused.reason)
        assertTrue(rows.list().isEmpty())
        assertTrue(writer.uploads.isEmpty())
    }

    @Test
    fun aRunThatDoesNotFitIsRefusedByTheCoresEstimateAndOneThatFitsExactlyStarts() {
        val results = listOf(PlannedResult.Known(5_000_000uL, true), PlannedResult.FromSources(2_000_000uL, false))
        val needed = runEstimate(results)
        val refused = assertThrows(SaveRefused::class.java) { SaveRun.start(FakeWriter(SaveRoom.Own(needed.toLong() - 1)), listOf(opened("f")), results, journal()) }
        assertEquals(SaveRefused.Reason.NO_ROOM, refused.reason)
        assertEquals(needed, refused.needed)
        assertEquals(needed.toLong() - 1, refused.free)
        val rows = journal()
        val run = SaveRun.start(FakeWriter(SaveRoom.Family(needed.toLong())), listOf(opened("f")), results, rows)
        assertEquals(listOf(run.id), rows.list().map { it.id })
    }

    @Test
    fun aResultPlannedWithoutAThumbnailMayNotCarryOne() {
        val run = SaveRun.start(FakeWriter(), listOf(opened("f")), listOf(PlannedResult.Known(1uL, false)), journal())
        assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a.png", "image/png", own, thumbnail = byteArrayOf(9)) }
    }

    @Test
    fun eachResultTakesTheNextFreeNameAndNeverReplaces() {
        val writer = FakeWriter().apply { names = listOf("report.pdf", "Report (2).pdf") }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        run.file(byteArrayOf(1), "report.pdf", null, own)
        run.file(byteArrayOf(1), "REPORT.pdf", null, own)
        assertEquals(listOf("report (3).pdf", "REPORT (4).pdf"), writer.uploads.map { it.first })
        assertTrue(writer.uploads.all { it.second == null })
    }

    @Test
    fun eachResultIsSignedByItsOwnSourcesTheWeakestOfThem() {
        val writer = FakeWriter()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        val verified = SaveSource.OfFile(Integrity.VERIFIED, Integrity.VERIFIED)
        run.file(byteArrayOf(1), "a", null, SaveSources.From(listOf(verified)))
        run.file(byteArrayOf(1), "b", null, SaveSources.From(listOf(verified,
            SaveSource.OfFolder(Integrity.VERIFIED, listOf(SaveSource.OfFile(Integrity.VERIFIED, Integrity.UNKNOWN_SIGNER))))))
        run.file(byteArrayOf(1), "c", null, SaveSources.From(listOf(SaveSource.of(Prior.FROM_LINK))))
        run.file(byteArrayOf(1), "d", null, own)
        val copies = writer.uploads.map { it.third }
        assertEquals(Prior(Integrity.VERIFIED, Integrity.VERIFIED), copies[0])
        assertEquals(Integrity.UNKNOWN_SIGNER, copies[1]!!.version)
        assertEquals(Prior(Integrity.SAVED_FROM_LINK, Integrity.SAVED_FROM_LINK), copies[2])
        assertEquals(null, copies[3])
        assertThrows(Exception::class.java) { run.file(byteArrayOf(1), "e", null, SaveSources.From(emptyList())) }
    }

    @Test
    fun aVersionSomeoneElseBeatIsStaleAndTheRunGoesOn() {
        val writer = FakeWriter().apply { answers.add { throw SaveStale("v-theirs") } }
        val rows = journal()
        val doc = opened("doc", parent = "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), emptyList(), rows)
        assertEquals(VersionSaved.Stale("v-theirs"), run.version(byteArrayOf(1), doc, opened("f"), "v1", own))
        assertEquals(emptyList<String>(), rows.list().single().nodeIds)
        run.file(byteArrayOf(2), "after.txt", null, own)
        run.finish()
        assertTrue(writer.trashed.isEmpty())
        assertTrue(rows.list().isEmpty())
    }

    @Test
    fun aVersionThatLandedBeforeACancelIsKeptAndSaidSo() {
        val writer = FakeWriter()
        val doc = opened("doc", parent = "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc, opened("f")), emptyList(), journal())
        run.version(byteArrayOf(1), doc, opened("f"), "v1", own)
        val stopped = run.cancel()
        assertEquals(1, stopped.keptVersions)
        assertFalse(stopped.message!!.contains("Nothing was saved"))
        assertTrue(stopped.message!!.contains("was kept"))
    }

    @Test
    fun aKeyOnlyRefusalLooksTheFileUpAgainAndSealsAfreshKeepingTheVersionItStartedFrom() {
        val writer = FakeWriter().apply {
            answers.add { throw SaveRekeyed() }
            fresh = { file -> opened(file.id, parent = "f", version = "v1", keyEpoch = 7uL) }
        }
        val doc = opened("doc", parent = "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), emptyList(), journal(), pause = {})
        assertTrue(run.version(byteArrayOf(1), doc, opened("f"), "v1", own) is VersionSaved.Saved)
        assertEquals(listOf(1uL, 7uL), writer.uploads.map { it.second!!.node.keyEpoch })
        assertEquals(listOf("v1", "v1"), writer.startedFrom)
        // A family key change waited out refreshes the file too (Codex: a stale keyEpoch would be refused forever).
        val family = FakeWriter().apply {
            answers.add { throw KeyChangeConflict(ApiError(409, "changed", "conflict", JSONObject().put("conflicted", true))) }
            fresh = { file -> opened(file.id, parent = "f", version = "v1", keyEpoch = 9uL) }
        }
        SaveRun.start(family, listOf(doc), emptyList(), journal(), pause = {}).version(byteArrayOf(1), doc, opened("f"), "v1", own)
        assertEquals(listOf(1uL, 9uL), family.uploads.map { it.second!!.node.keyEpoch })
        // Its file gone from the folder by the next look: stale, never a new file there.
        val gone = FakeWriter().apply {
            answers.add { throw SaveRekeyed() }
            fresh = { null }
        }
        assertEquals(VersionSaved.Stale(null), SaveRun.start(gone, listOf(doc), emptyList(), journal(), pause = {}).version(byteArrayOf(1), doc, opened("f"), "v1", own))
    }

    @Test
    fun aCancelDeletesForeverWhatWasPublishedAndTheRowGoes() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        assertEquals(listOf("node-1"), rows.list().single().nodeIds)
        val stopped = run.cancel()
        assertEquals(SaveCleanup.DELETED, stopped.cleanup)
        assertEquals(SaveRuns.CANCELLED, stopped.message)
        assertEquals(setOf("node-1"), writer.purged)
        assertTrue(rows.list().isEmpty())
        assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "b", null, own) }
    }

    @Test
    fun aSecondStopWaitsForTheFirstsOutcomeAndWaitingNeverWaitsOnTheNetwork() {
        val writer = FakeWriter()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        run.file(byteArrayOf(1), "a", null, own)
        val inTrash = CountDownLatch(1)
        val release = CountDownLatch(1)
        val slow = object : SaveRunWriter by writer {
            override fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> {
                inTrash.countDown()
                release.await(5, TimeUnit.SECONDS)
                return writer.trash(ids, workspaceId)
            }
        }
        val slowRun = SaveRun.start(slow, listOf(opened("f")), emptyList(), journal())
        slowRun.file(byteArrayOf(1), "b", null, own)
        val pool = Executors.newFixedThreadPool(2)
        val first = pool.submit<SaveRunStopped> { slowRun.cancel() }
        assertTrue(inTrash.await(5, TimeUnit.SECONDS))
        val second = pool.submit<SaveRunStopped> { slowRun.cancel() }
        // While the clean-up is on the network, the run still answers at once.
        assertEquals(0, slowRun.waiting())
        release.countDown()
        assertEquals(SaveCleanup.DELETED, first.get(5, TimeUnit.SECONDS).cleanup)
        assertEquals(SaveCleanup.DELETED, second.get(5, TimeUnit.SECONDS).cleanup)
        pool.shutdown()
        run.cancel()
    }

    @Test
    fun aResultHandedInWhileTheFolderWasListedAndTheRunStoppedNeverUploads() {
        val writer = FakeWriter()
        val listing = CountDownLatch(1)
        val go = CountDownLatch(1)
        writer.listing = { listing.countDown(); go.await(5, TimeUnit.SECONDS) }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        val pool = Executors.newSingleThreadExecutor()
        val late = pool.submit<Opened> { run.file(byteArrayOf(1), "late", null, own) }
        assertTrue(listing.await(5, TimeUnit.SECONDS))
        run.cancel()
        go.countDown()
        val thrown = runCatching { late.get(5, TimeUnit.SECONDS) }.exceptionOrNull()
        assertTrue(thrown?.cause is SaveRunStopped)
        assertTrue(writer.uploads.isEmpty())
        pool.shutdown()
    }

    @Test
    fun aNoRoomInSomeoneElsesShareStopsTheRunUnfiguredAndOnlyTrashes() {
        val writer = FakeWriter(room = SaveRoom.Shared).apply {
            member = false
            answers.add { }
            answers.add { throw ApiError(402, "There isn’t enough room. 12 MB free.") }
        }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("shared")), listOf(PlannedResult.Known(1uL shl 50, true)), rows)
        run.file(byteArrayOf(1), "a", null, own)
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "b", null, own) }
        assertEquals(SaveRunStopped.Reason.NO_ROOM, stopped.reason)
        assertEquals(SaveRuns.NO_ROOM_SHARED, stopped.message)
        assertFalse(stopped.message!!.contains("12 MB"))
        assertEquals(SaveCleanup.TRASHED, stopped.cleanup)
        // node-2 never landed (the trash finds nothing there); node-1 did, and goes to the owner's Trash only.
        assertEquals(setOf("node-1"), writer.trashed)
        assertTrue(writer.purged.isEmpty())
        assertTrue("up-2" in writer.aborted)
        assertTrue(rows.list().isEmpty())
    }

    @Test
    fun unknownFiguresInThePersonsOwnSpaceNeverSaySharedFolder() {
        val writer = FakeWriter(room = SaveRoom.Own(null)).apply { answers.add { throw ApiError(402, "No room") } }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        assertEquals(SaveRuns.NO_ROOM, assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }.message)
    }

    @Test
    fun aFolderTheRunMadeGoesAsOne() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val made = run.folder("Archive", own)
        run.file(byteArrayOf(1), "inside.txt", null, own, folder = made)
        assertEquals(listOf(made.id), rows.list().single().nodeIds)
        run.cancel()
        assertEquals(setOf(made.id), writer.purged)
    }

    @Test
    fun aKeyChangeStillWalkingTheFolderIsWaitedOutNotFailed() {
        val writer = FakeWriter().apply { answers.add { throw ApiError(409, "Finishing a key change…", "rotating") } }
        var pauses = 0
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), journal(), pause = { pauses++ })
        assertEquals("node-2", run.file(byteArrayOf(1), "a", null, own).id)
        assertEquals(1, pauses)
    }

    @Test
    fun perItemRefusalsABusyPurgeOrNoAnswerKeepTheRow() {
        for (breakIt in listOf<(FakeWriter) -> Unit>({ it.refuse += "node-1" }, { it.busy += "node-1" }, { it.offline = true })) {
            val writer = FakeWriter()
            val rows = journal()
            val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
            run.file(byteArrayOf(1), "a", null, own)
            breakIt(writer)
            assertEquals(SaveCleanup.LEFT, run.cancel().cleanup)
            assertEquals(listOf(listOf("node-1")), rows.list().map { it.nodeIds })
        }
    }

    @Test
    fun theNextLaunchFindsAnInterruptedRunDeletesOrKeepsWhatItMadeAndDropsOneItCanNoLongerReach() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        assertTrue(SaveRuns.interrupted(rows).isEmpty())
        val other = SaveRunRow("other", "ws", listOf("node-x"), listOf("up-x"), 1L, "an-earlier-launch")
        rows.put(other)
        assertEquals(listOf("other"), SaveRuns.interrupted(rows).map { it.id })
        writer.offline = true
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(other, writer, rows))
        assertTrue(rows.list().any { it.id == "other" })
        // Keep with no answer (offline, an older server): the row goes all the same; the server lets an open upload expire.
        SaveRuns.keep(other, writer, rows)
        assertFalse(rows.list().any { it.id == "other" })
        writer.offline = false
        rows.put(other)
        writer.denied = true
        assertEquals(SaveCleanup.NO_ACCESS, SaveRuns.cleanUp(other, writer, rows))
        assertFalse(rows.list().any { it.id == "other" })
        writer.denied = false
        rows.put(other)
        SaveRuns.keep(other, writer, rows)
        assertTrue("up-x" in writer.aborted)
        assertFalse(rows.list().any { it.id == "other" })
        run.cancel()
    }

    @Test
    fun aSignOutEndsTheJournalNothingIsWrittenAfter() {
        val writer = FakeWriter()
        val session = SaveRunJournal.Epoch()
        val rows = journal(session)
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        // What AccountStore.wipe does through SaveRunJournal.endAccount(), on this journal's own session.
        session.end()
        rows.file.delete()
        // A result handed in after the account was wiped, the sign-out not having reached the run: refused, nothing uploaded,
        // no row written back.
        assertEquals(SaveRunStopped.Reason.SIGNED_OUT, assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }.reason)
        assertThrows(SaveRunStopped::class.java) { run.folder("Out", own) }
        assertTrue(writer.uploads.isEmpty())
        assertFalse(rows.file.exists())
        // The real sign-out ends every journal on the account's session.
        val accountJournal = journal(SaveRunJournal.account)
        SaveRunJournal.endAccount()
        assertFalse(accountJournal.live)
    }

    @Test
    fun aNewFileRefusedForAKeyChangeIsSealedAgainUnderTheFolderAsTheServerHoldsItNow() {
        val writer = FakeWriter().apply { answers.add { throw SaveRekeyed() } }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal(), pause = {})
        run.file(byteArrayOf(1), "a", null, own)
        // Sealed first under the folder as held, then under the folder looked up again.
        assertEquals(listOf(1uL, 2uL), writer.folderEpochs)
        assertEquals(1, writer.refreshes)
    }

    @Test
    fun aResultFolderWaitsOutAKeyChangeAsItsUploadsDo() {
        val writer = FakeWriter().apply { folderAnswers.add { throw ApiError(409, "Finishing a key change…", "rotating") } }
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), journal(), pause = {})
        assertEquals("made-Archive", run.folder("Archive", own).id)
        assertEquals(listOf(1uL, 2uL), writer.folderEpochs)
    }

    @Test
    fun aLateFolderThatCannotBeRemovedIsAddedToTheRowAFailedCleanUpKept() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        writer.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) }
        val pool = Executors.newSingleThreadExecutor()
        val folder = pool.submit<Opened> { run.folder("Archive", own) }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        // The stop's clean-up fails for the file it made, and later for the late folder too.
        writer.refuse += "node-1"
        writer.refuse += "made-Archive"
        assertEquals(SaveCleanup.LEFT, run.cancel().cleanup)
        go.countDown()
        runCatching { folder.get(5, TimeUnit.SECONDS) }
        assertEquals(listOf(listOf("node-1", "made-Archive")), rows.list().map { it.nodeIds })
        pool.shutdown()
    }

    @Test
    fun aSignOutAbandonsLiveRunsAndOneThatLandsAfterDeletesNothing() {
        val writer = FakeWriter()
        val landing = CountDownLatch(1)
        val go = CountDownLatch(1)
        writer.landing = { landing.countDown(); go.await(5, TimeUnit.SECONDS) }
        val session = SaveRunJournal.Epoch()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal(session))
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(landing.await(5, TimeUnit.SECONDS))
        // What AccountStore.wipe does through SaveRuns.abandonAll(), on this run's own session.
        SaveRuns.abandonAll(session)
        go.countDown()
        val thrown = runCatching { saving.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause
        assertEquals(SaveRunStopped.Reason.SIGNED_OUT, (thrown as SaveRunStopped).reason)
        assertTrue(writer.trashed.isEmpty())
        assertTrue(writer.aborted.isEmpty())
        pool.shutdown()
    }

    /*
     * A completion that named another item than the one written (ResultLanded): never handed to the tool as an exception that
     * means success. The run stops: a new version, landed, is kept and said so; a new file goes with the rest.
     */
    @Test
    fun aCompletionNamingAnotherItemStopsTheRunKeepingAVersionAndRemovingAFile() {
        val doc = opened("doc", parent = "f", version = "v1")
        val writer = FakeWriter().apply {
            answers.add { n -> open -= "up-$n"; finished += "up-$n"; throw ResultLanded("doc", IllegalStateException("another item")) }
        }
        val run = SaveRun.start(writer, listOf(doc), emptyList(), journal())
        val stopped = assertThrows(SaveRunStopped::class.java) { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
        assertEquals(SaveRunStopped.Reason.FAILED, stopped.reason)
        assertEquals(1, stopped.keptVersions)
        assertTrue(writer.trashed.isEmpty())

        val files = FakeWriter().apply {
            answers.add { n -> open -= "up-$n"; finished += "up-$n"; live += "node-$n"; throw ResultLanded("node-$n", IllegalStateException("another item")) }
        }
        val rows = journal()
        val next = SaveRun.start(files, listOf(opened("f")), emptyList(), rows)
        assertEquals(SaveCleanup.DELETED, assertThrows(SaveRunStopped::class.java) { next.file(byteArrayOf(1), "a", null, own) }.cleanup)
        assertEquals(setOf("node-1"), files.purged)
        assertTrue(rows.list().isEmpty())
    }

    /* The server still completing a version when the abort's tries ran out: it may land, so nothing says it didn't. */
    @Test
    fun aCompletionSlowerThanTheAbortsTriesKeepsTheRowAndSaysTheVersionMayHaveBeenSaved() {
        val doc = opened("doc", parent = "f", version = "v1")
        val landing = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply {
            completing += "up-1"
            this.landing = { landing.countDown(); go.await(5, TimeUnit.SECONDS) }
        }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(doc), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<VersionSaved> { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
        assertTrue(landing.await(5, TimeUnit.SECONDS))
        val stopped = run.cancel()
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertEquals(0, stopped.keptVersions)
        assertEquals(1, stopped.uncertainVersions)
        assertEquals("Cancelled. A new version may have been saved. Nothing else was saved.", stopped.message)
        assertEquals(listOf(listOf("up-1")), rows.list().map { it.uploadIds })
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
        pool.shutdown()
    }

    /* A disk that won't take the row: the run never starts, or stops before anything is sent; one refusal is written again. */
    @Test
    fun aRowTheDiskRefusesStopsTheRunBeforeAnythingIsSentAndOneRefusalIsWrittenAgain() {
        val refusing = journal().apply { fault = { throw java.io.IOException("full") } }
        assertEquals(SaveRuns.UNRECORDED, assertThrows(SaveRunStopped::class.java) { SaveRun.start(FakeWriter(), listOf(opened("f")), emptyList(), refusing) }.message)

        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        rows.fault = { throw java.io.IOException("full") }
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }
        assertEquals(SaveRunStopped.Reason.FAILED, stopped.reason)
        assertTrue(stopped.message!!.contains("couldn’t keep a record"))
        // Begun, then refused before a part was sent: never landed, its reservation aborted.
        assertTrue(writer.live.isEmpty())
        assertTrue("up-1" in writer.aborted)

        // One refused write (a moment's failure) is written once more: the run goes on.
        val once = journal()
        val flaky = SaveRun.start(FakeWriter(), listOf(opened("f")), emptyList(), once)
        var refusals = 1
        once.fault = { if (refusals-- > 0) throw java.io.IOException("busy") }
        flaky.file(byteArrayOf(1), "a", null, own)
        assertEquals(listOf("node-1"), once.list().single().nodeIds)
        flaky.finish()
    }

    /* A begin still on its way at the cancel: the empty row went, the file lands, can't be removed, and a row names it. */
    @Test
    fun aLateFileThatCannotBeRemovedAfterTheRowWentGetsARowOfItsOwn() {
        val beginning = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.beginning = { beginning.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(beginning.await(5, TimeUnit.SECONDS))
        assertEquals(SaveCleanup.NOTHING, run.cancel().cleanup)
        assertTrue(rows.list().isEmpty())
        writer.refuse += "node-1"
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
        assertEquals(listOf(listOf("node-1")), rows.list().map { it.nodeIds })
        assertEquals(run.id, rows.list().single().id)
        pool.shutdown()
    }

    /* A sign-out while a run starts: abandonAll can't reach it yet, so it never starts and writes no row. */
    @Test
    fun aSignOutWhileARunStartsLeavesNoRunAndNoRow() {
        val session = SaveRunJournal.Epoch()
        val rows = journal(session)
        val writer = FakeWriter().apply { roomHook = { session.end() } }
        assertEquals(SaveRunStopped.Reason.SIGNED_OUT, assertThrows(SaveRunStopped::class.java) { SaveRun.start(writer, listOf(opened("f")), emptyList(), rows) }.reason)
        assertTrue(rows.list().isEmpty())
    }

    /* A refresh after a key-change pause: one the change still holds up waits again; any other failure stops the run. */
    @Test
    fun aRefreshTheKeyChangeHoldsUpWaitsAndAnyOtherFailureStopsTheRun() {
        val writer = FakeWriter().apply {
            answers.add { throw ApiError(409, "Finishing a key change…", "rotating") }
            // The ledger hasn't learned the new keys yet: the open through it says so (FamilyUploads.waits).
            refreshAnswers.add { throw FamilyFailure("This item was wrapped under an older folder key.") }
        }
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), journal(), pause = {})
        run.file(byteArrayOf(1), "a", null, own)
        assertEquals(2, writer.refreshes)

        val broken = FakeWriter().apply {
            answers.add { throw ApiError(409, "Finishing a key change…", "rotating") }
            refreshAnswers.add { throw ApiError(500, "Something went wrong.") }
        }
        val rows = journal()
        val failing = SaveRun.start(broken, listOf(opened("fam")), emptyList(), rows, pause = {})
        assertEquals(SaveRunStopped.Reason.FAILED, assertThrows(SaveRunStopped::class.java) { failing.file(byteArrayOf(1), "a", null, own) }.reason)
        // Stopped, not left open: its row went with the clean-up, and later work is refused.
        assertTrue(rows.list().isEmpty())
        assertThrows(SaveRunStopped::class.java) { failing.file(byteArrayOf(1), "b", null, own) }

        val folderBroken = FakeWriter().apply {
            folderAnswers.add { throw ApiError(409, "Finishing a key change…", "rotating") }
            refreshAnswers.add { throw ApiError(500, "Something went wrong.") }
        }
        val folders = SaveRun.start(folderBroken, listOf(opened("fam")), emptyList(), journal(), pause = {})
        assertThrows(SaveRunStopped::class.java) { folders.folder("Archive", own) }
        assertThrows(SaveRunStopped::class.java) { folders.file(byteArrayOf(1), "b", null, own) }
    }

    /* Real statements: a result of a verified source and one nobody could check is re-sealed (never refused, never vouched for). */
    @Test
    fun aResultWithAnUncheckedSourceIsResealedNotRefused() {
        val prior = SaveRuns.signing(SaveSources.From(listOf(SaveSource.OfFile(Integrity.VERIFIED, Integrity.VERIFIED), SaveSource.OfFile(Integrity.VERIFIED, Integrity.UNCHECKED))))!!
        assertEquals(Integrity.RESEALED, prior.version)
        val seed = randomBytes(32u)
        val statement = VersionStatement("600e9d40-c3b4-49bd-8e63-9bd7b3f63dbc", "dc94437c-d237-4f94-bef8-9caeb51bea5e", "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d", "471517d1-c35e-4f99-83b9-067be718ecb1", 3u)
        val envelope = randomBytes(84u)
        val signature = copyVersionSignature(seed, statement, envelope, prior)
        assertEquals(Integrity.RESEALED, versionIntegrity(TrustedKeys(signingPublicKey(seed), emptyList()), statement, envelope, signature))
    }
}

/* The vault's own upload from memory, against the fake Drive. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SaveResultTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault
    private lateinit var context: Context

    @Before
    fun signIn() {
        context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("save-result-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        vault.listChildren(server.root)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* Every file on this device's disk the app can write to that holds `bytes`. */
    private fun holding(bytes: ByteArray): List<File> {
        val needle = String(bytes, Charsets.ISO_8859_1)
        val roots = listOf(context.cacheDir, context.filesDir, context.noBackupFilesDir, File(System.getProperty("java.io.tmpdir")!!))
        return roots.flatMap { root -> root.walkTopDown().filter { it.isFile && it.length() < 64L shl 20 }.toList() }
            .filter { file -> runCatching { String(file.readBytes(), Charsets.ISO_8859_1).contains(needle) }.getOrDefault(false) }
    }

    /* Fails if the result is staged in a file on its way (plaintext on disk while its parts go up), or what lands is not the bytes given. */
    @Test
    fun aResultUploadsFromMemoryNeverTouchingTheDiskAndLandsAsItsBytes() {
        val bytes = "tool output ${UUID.randomUUID()}, never on disk".toByteArray()
        var onDisk: List<File>? = null
        server.beforeAnswer = { method, path -> if (method == "PUT" && path.startsWith("/store/")) onDisk = holding(bytes) }
        val landed = vault.uploadResult(bytes, "out.txt", "text/plain", server.root, null, null, copy = null)
        server.beforeAnswer = null
        assertEquals(emptyList<File>(), onDisk)
        assertEquals("out.txt", server.record(landed.id).name)
        val copy = File.createTempFile("downloaded", ".txt")
        try {
            vault.download(landed.id, copy)
            assertArrayEquals(bytes, copy.readBytes())
        } finally {
            copy.delete()
        }
    }

    /* Fails if a new version that lost the race lands over theirs, or keeps its room reserved. */
    @Test
    fun aNewVersionThatLostTheRaceIsStaleAndItsUploadAborted() {
        val id = server.file(server.root, "doc.txt", "first".toByteArray())
        val doc = vault.listChildren(server.root).single { it.id == id }
        val startedFrom = doc.node.currentVersion?.id
        assertNotNull(startedFrom)
        // Older than what the file holds as this device listed it: stale before anything is begun.
        val early = assertThrows(SaveStale::class.java) {
            vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, "an-older-version", copy = null)
        }
        assertEquals(startedFrom, early.currentVersionId)
        assertFalse(server.requests.any { it.endsWith("drive/uploads") })
        // Another device saves while this one's bytes go up: the completion is refused, aborted, and stale with theirs.
        server.beforeAnswer = { method, path -> if (method == "POST" && path.endsWith("/complete")) server.newVersion(id, "theirs".toByteArray()) }
        val raced = assertThrows(SaveStale::class.java) {
            vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, startedFrom, copy = null)
        }
        server.beforeAnswer = null
        val theirs = server.node(id).version?.id
        assertEquals(theirs, raced.currentVersionId)
        assertTrue(theirs != startedFrom)
        assertTrue(server.requests.any { it.contains("/abort") })
    }

    /*
     * A tool's new version leaves the file's name record as it is (docs/editing-design.md section 3, as the web does):
     * nothing is signed again (so nothing waits on whom to trust). Fails if the record is sealed or signed again.
     */
    @Test
    fun aToolsNewVersionLeavesTheNameRecordAndNeedsNoTrustSet() {
        val id = server.file(server.root, "doc.txt", "first".toByteArray())
        val doc = vault.listChildren(server.root).single { it.id == id }
        val before = server.node(id)
        val (version, envelope) = before.metadataVersion to before.metadataEnvelope
        val sent = server.requests.size
        vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, doc.node.currentVersion!!.id, copy = null)
        assertTrue(server.node(id).version?.id != doc.node.currentVersion!!.id)
        assertEquals(version, server.node(id).metadataVersion)
        assertEquals(envelope, server.node(id).metadataEnvelope)
        assertFalse(server.requests.drop(sent).any { it.contains("/nodes/$id/metadata") })
    }

    /* An abort answered "still finishing" is asked again, and settles as the server then says. */
    @Test
    fun anUploadStillFinishingIsAskedAgainBeforeTheCleanUpDecides() {
        val replies = ArrayDeque(listOf("completing", "completed"))
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "abort" && replies.isNotEmpty())
                409 to JSONObject().put("code", "conflict").put("message", "finishing").put("data", JSONObject().put("upload", replies.removeFirst()))
            else null
        }
        val writer = VaultSaveWriter(vault) { throw IllegalStateException("not asked") }
        assertEquals(SaveAbortFate.FINISHED, writer.abortUpload("up", server.workspace))
        assertTrue(replies.isEmpty())
        // Still finishing after every try: no answer, never finished (its node is published only once it completes).
        replies.addAll(List(5) { "completing" })
        assertEquals(SaveAbortFate.UNKNOWN, writer.abortUpload("up", server.workspace, 0L))
        // A self-hosted server from before `data.upload` says which in words.
        val words = ArrayDeque(listOf(DriveApi.STILL_FINISHING, DriveApi.ALREADY_FINISHED, "Something else."))
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "abort" && words.isNotEmpty())
                409 to JSONObject().put("code", "conflict").put("message", words.removeFirst())
            else null
        }
        assertEquals(SaveAbortFate.FINISHED, writer.abortUpload("up", server.workspace, 0L))
        assertEquals(SaveAbortFate.UNKNOWN, writer.abortUpload("up", server.workspace, 0L))
    }

    /*
     * The run's row refused at begin: no part and no completion are sent, the reservation is aborted, and one whose abort got
     * no answer is left idle, for settleAll to settle (apps/android/AGENTS.md, failed records). Fails if a failed begin note
     * leaves the reservation marked active, skipped until the process restarts.
     */
    @Test
    fun aBeginWhoseRowCannotBeWrittenSendsNothingAndLeavesItsReservationToSettle() {
        val parts = java.util.concurrent.atomic.AtomicInteger()
        server.beforeAnswer = { method, path -> if (method == "PUT" && path.startsWith("/store/")) parts.incrementAndGet() }
        var aborts = 0
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "abort" && aborts++ == 0) 503 to JSONObject().put("message", "unavailable") else null
        }
        val begun = ArrayList<String>()
        assertThrows(SaveUnrecorded::class.java) {
            vault.uploadResult("tool output".toByteArray(), "out.txt", null, server.root, null, null, copy = null,
                onBegun = { begun += it.uploadId; throw SaveUnrecorded(java.io.IOException("full")) })
        }
        server.beforeAnswer = null
        assertEquals(0, parts.get())
        assertTrue(server.requests.none { it.contains("/complete") })
        val settled = ArrayList<String>()
        Reservations.settleAll(context) { id, ws -> settled += id; vault.api.abortUpload(id, ws) }
        assertEquals(begun, settled)
    }

    /* A new file's 409 that is not the completion's `conflicted` ("This upload was cancelled") is no key change. */
    @Test
    fun aCancelledUploadIsNotTakenForAKeyChange() {
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "complete") 409 to JSONObject().put("code", "conflict").put("message", "This upload was cancelled.")
            else null
        }
        val thrown = runCatching { vault.uploadResult("mine".toByteArray(), "new.txt", null, server.root, null, null, copy = null) }.exceptionOrNull()
        assertTrue("$thrown", thrown is ApiError && thrown !is SaveRekeyed)
    }

    /* A completion refused only because the file was re-keyed (its version unchanged): sealed afresh, never stale, never failed. */
    @Test
    fun aKeyOnlyRefusalAtCompletionIsRekeyedAndAFileGoneIsStale() {
        val id = server.file(server.root, "doc.txt", "first".toByteArray())
        val doc = vault.listChildren(server.root).single { it.id == id }
        var refused = false
        server.extraRoutes = { method, segments, _, _ ->
            if (!refused && method == "POST" && segments.lastOrNull() == "complete") {
                refused = true
                409 to JSONObject().put("code", "conflict").put("message", "This file changed while it was uploading.")
                    .put("data", JSONObject().put("conflicted", true).put("currentVersionId", doc.node.currentVersion!!.id))
            } else null
        }
        assertThrows(SaveRekeyed::class.java) {
            vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, doc.node.currentVersion!!.id, copy = null)
        }
        // The same refusal for a file no longer in its folder: stale, never a new file where it was.
        refused = false
        server.trash(id)
        assertEquals(null, assertThrows(SaveStale::class.java) {
            vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, doc.node.currentVersion!!.id, copy = null)
        }.currentVersionId)
    }
}
