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
    private fun opened(id: String, parent: String? = "root", version: String? = null, keyEpoch: ULong = 1uL, name: String = id,
                       workspace: String = "ws"): Opened {
        val current = version?.let { VersionView(it, "o", "", "ready", 3u, 1, "n", null, null, null) }
        val node = NodeView(id, workspace, parent, if (version == null) "folder" else "file", keyEpoch, 1uL, "", 1uL, "", current, null, null, null)
        return Opened(node, NodeMetadata(name, null, null, null, emptyMap()))
    }

    /* A journal of its own session: another test's sign-out (AccountStoreTest wipes) never ends it. */
    private fun journal(epoch: SaveRunJournal.Epoch = SaveRunJournal.Epoch()) =
        SaveRunJournal(Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile(), epoch)
    private val own = SaveSources.OwnWriting

    /* The drive as a run's clean-up meets it: nodes live, in the Trash or deleted; uploads open or finished. */
    private class FakeWriter(var room: SaveRoom = SaveRoom.Own(1L shl 40)) : SaveRunWriter {
        override var account: String? = "me"
        var refusal: String? = null
        var names = listOf<String>()
        var member = true
        var offline = false
        var denied = false
        /* A family manager paused this person's changes: every write refused `held`. */
        var held = false
        val refuse = HashSet<String>()
        val busy = HashSet<String>()
        val live = HashSet<String>()
        val trashed = HashSet<String>()
        val purged = HashSet<String>()
        val open: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())
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
        /* A folder created whose answer never comes back. */
        var loseAnswer = false
        /* The answer is cut while the server is still making the folder: it lands in `later`, made once the test says. */
        var createLater = false
        val later = ArrayList<String>()
        /* A creation the server refuses with its reason. */
        var refuseCreation: ApiError? = null
        /* Items in a folder, for lookFolder; and a hook that runs before each look. */
        val items = HashMap<String, Int>()
        var looking: (() -> Unit)? = null
        /* Parts each upload sends, a few milliseconds apart; one for an upload already aborted is refused, as the store does. */
        var parts = 1
        @Volatile var stopStarted = false
        @Volatile var partsAfterStop = 0
        var namesFail = false
        var uploading: (() -> Unit)? = null
        /* Uploads whose parts went out after their begin was taken. */
        var partsSent = 0
        private var count = 0

        override fun refusal(target: Opened) = refusal
        override fun room(workspaceId: String): SaveRoom { roomHook?.invoke(); return room }
        override fun names(folder: Opened): List<String> {
            listing?.invoke()
            if (namesFail) throw Unreachable()
            return names
        }
        override fun makeFolder(folder: Opened, name: String, copy: Prior?, minted: (String) -> Unit): Opened {
            folderEpochs += folder.node.keyEpoch
            folderAnswers.removeFirstOrNull()?.invoke()
            // Its id heard before the creation is sent, as the vault's createFolder does.
            minted("made-$name")
            making?.invoke()
            refuseCreation?.let { throw it }
            if (createLater) { later += "made-$name"; throw Unreachable() }
            live += "made-$name"
            if (loseAnswer) throw Unreachable()
            return Opened(NodeView("made-$name", "ws", folder.id, "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()))
        }
        override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                                  thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit, onCompleting: (String) -> Unit): Opened {
            val n = ++count
            uploads.add(Triple(name, replacing, copy))
            folderEpochs += folder.node.keyEpoch
            this.startedFrom.add(startedFrom)
            val nodeId = replacing?.id ?: "node-$n"
            open += "up-$n"
            beginning?.invoke()
            try {
                onBegun(Vault.BegunIds(beginWorkspace, "up-$n", nodeId))
            } catch (error: Exception) {
                // As the vault does: nothing is sent, the reservation goes.
                open -= "up-$n"
                aborted += "up-$n"
                throw error
            }
            // Its parts on their way, the completion not yet sent.
            repeat(parts) {
                if ("up-$n" !in open) throw ApiError(404, "There is no such upload.")
                if (stopStarted) partsAfterStop++
                if (parts > 1) Thread.sleep(10)
            }
            partsSent++
            uploading?.invoke()
            answers.removeFirstOrNull()?.invoke(n)
            try {
                onCompleting("up-$n")
            } catch (error: Exception) {
                // As the vault does: a run that stopped refuses the completion, and the reservation goes.
                open -= "up-$n"
                aborted += "up-$n"
                throw error
            }
            landing?.invoke()
            open -= "up-$n"
            finished += "up-$n"
            if (replacing == null) live += nodeId
            return Opened(NodeView(nodeId, "ws", folder.id, "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()))
        }
        /* There, but out of this person's reach (a share that ended): answered not found. */
        val unreachable = HashSet<String>()
        /* Folders found whose items can't be counted (in the Trash). */
        val uncounted = HashSet<String>()
        override fun lookFolder(id: String, workspaceId: String): FolderCount? {
            looking?.invoke()
            if (offline) throw Unreachable()
            if (id in unreachable) return null
            if (id in uncounted) return FolderCount.Uncounted
            return if (id in live || id in trashed) FolderCount.Items(items[id] ?: 0) else null
        }
        override fun fresh(file: Opened, folder: Opened): Opened? {
            val look = fresh ?: return file
            return look(file)
        }
        /* The workspace a begin is answered in; a re-listing that names another folder. */
        var beginWorkspace = "ws"
        var refreshedAs: Opened? = null
        override fun refreshFolder(folder: Opened): Opened {
            refreshes++
            refreshAnswers.removeFirstOrNull()?.invoke()
            refreshedAs?.let { return it }
            return Opened(folder.node.copy(keyEpoch = folder.node.keyEpoch + 1uL), folder.metadata)
        }
        /* Runs as each abort is asked (the vault's pause while an upload is still finishing). */
        var abortPause: (() -> Unit)? = null
        override fun abortUpload(uploadId: String, workspaceId: String): SaveAbortFate {
            abortPause?.invoke()
            if (offline) return SaveAbortFate.UNKNOWN
            if (held) return SaveAbortFate.HELD
            if (denied) return SaveAbortFate.DENIED
            if (uploadId in completing) return SaveAbortFate.UNKNOWN
            aborted += uploadId
            if (uploadId in finished) return SaveAbortFate.FINISHED
            return if (open.remove(uploadId)) SaveAbortFate.ABORTED else SaveAbortFate.GONE
        }
        /* Every request a clean-up sends, in order; and a hook that runs once a trash has been answered. */
        val sent = java.util.Collections.synchronizedList(ArrayList<String>())
        var afterTrash: (() -> Unit)? = null
        override fun trash(ids: List<String>, workspaceId: String): Map<String, SaveItemFate> {
            sent += "trash"
            if (offline) throw Unreachable()
            val fates = ids.associateWith { id ->
                when {
                    held -> SaveItemFate.HELD
                    denied -> SaveItemFate.DENIED
                    id in refuse -> SaveItemFate.REFUSED
                    id in unreachable -> SaveItemFate.GONE
                    live.remove(id) -> { trashed += id; SaveItemFate.DONE }
                    id in trashed -> SaveItemFate.DONE
                    else -> SaveItemFate.GONE
                }
            }
            afterTrash?.invoke()
            return fates
        }
        override fun purge(ids: List<String>, workspaceId: String) = ids.also { sent += "purge" }.associateWith { id ->
            when {
                id in busy -> SaveItemFate.REFUSED
                trashed.remove(id) -> { purged += id; SaveItemFate.DONE }
                else -> SaveItemFate.GONE
            }
        }
        override fun mayPurge(workspaceId: String): Boolean? = member.also { sent += "may-purge" }
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
        // Refused before anything is sent: not a stop, nothing cleaned up, and the run goes on.
        assertThrows(SaveRunRefusal::class.java) { run.file(byteArrayOf(1), "a.png", "image/png", own, thumbnail = byteArrayOf(9)) }
        run.file(byteArrayOf(1), "b.png", "image/png", own)
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

    /* A stale version gives back its thumbnail's room: Save on top or Save as a copy may carry the same thumbnail. */
    @Test
    fun aStaleVersionGivesBackItsThumbnailsRoom() {
        val writer = FakeWriter().apply { answers.add { throw SaveStale("v-theirs") } }
        val doc = opened("doc", parent = "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), listOf(PlannedResult.Known(1uL, true)), journal())
        val thumb = byteArrayOf(9, 9)
        assertEquals(VersionSaved.Stale("v-theirs"), run.version(byteArrayOf(1), doc, opened("f"), "v1", own, thumbnail = thumb))
        // Save on top, with the same thumbnail, within the one planned.
        run.version(byteArrayOf(1), doc, opened("f"), "v-theirs", own, thumbnail = thumb)
        assertEquals(2, writer.uploads.size)
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

    /*
     * A row another launch left with nothing made is never offered: it goes quietly, its uploads left to the reservations
     * ledger, which lets them go.
     */
    @Test
    fun aRowWithNothingMadeIsNeverOfferedAndGoes() {
        val writer = FakeWriter()
        val rows = journal()
        rows.put(SaveRunRow("versions", "ws", emptyList(), listOf("up-x"), 1L, "an-earlier-launch", account = "me"))
        rows.put(SaveRunRow("empty", "ws", emptyList(), emptyList(), 1L, "an-earlier-launch", account = "me"))
        rows.put(SaveRunRow("made", "ws", listOf("node-x"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        assertEquals(listOf("made"), SaveRuns.interrupted(rows, writer).map { it.id })
        assertEquals(listOf("made"), rows.list().map { it.id })
    }

    /* Not found, to someone who isn't a member, is gone only while every folder the run saved into is still found. */
    @Test
    fun notFoundToSomeoneNotAMemberIsGoneOnlyWhileEveryDestinationIsFound() {
        // An editor of two of one owner's folders who lost only the result's: its file still there.
        val writer = FakeWriter().apply { member = false; live += "node-a"; unreachable += "node-a"; unreachable += "dest" }
        val rows = journal()
        val row = SaveRunRow("r", "ws", listOf("node-a"), emptyList(), 1L, "an-earlier-launch", account = "me", destinations = listOf("dest"))
        rows.put(row)
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(row, writer, rows))
        assertEquals(row, rows.list().single())
        assertTrue("node-a" in writer.live)
        // No destinations named (an older row): not known to be reached either.
        val unnamed = row.copy(id = "u", destinations = emptyList())
        rows.put(unnamed)
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(unnamed, writer, rows))
        assertEquals(unnamed, rows.list().single { it.id == "u" })
        // Every destination still found: the person reaches them, so "not found" is gone.
        val reached = FakeWriter().apply { member = false; live += "dest" }
        val again = journal()
        again.put(row)
        assertEquals(SaveCleanup.NOTHING, SaveRuns.cleanUp(row, reached, again))
        assertTrue(again.list().isEmpty())
        // A member reaches all of the space: gone, without looking.
        val member = FakeWriter()
        val theirs = journal()
        theirs.put(row.copy(destinations = emptyList()))
        assertEquals(SaveCleanup.NOTHING, SaveRuns.cleanUp(row.copy(destinations = emptyList()), member, theirs))
        // A run's row names the folders it saves into.
        val run = SaveRun.start(member, listOf(opened("f")), emptyList(), theirs)
        assertEquals(listOf("f"), theirs.list().single { it.id == run.id }.destinations)
        run.finish()
    }

    /* A waiting folder found in the Trash is never said to hold nothing. */
    @Test
    fun aWaitingFolderFoundInTheTrashIsNeverSaidToHoldNothing() {
        val writer = FakeWriter().apply { trashed += "slow"; uncounted += "slow"; live += "full"; items["full"] = 2 }
        val rows = journal()
        rows.put(SaveRunRow("answered", "ws", listOf("slow", "full"), emptyList(), 1L, "an-earlier-launch", uncertain = mapOf("slow" to 1L),
            chosenDelete = true, account = "me"))
        SaveRuns.interrupted(rows, writer)
        SaveRuns.quietlySettled()
        val seen = rows.list().single()
        assertEquals(2, seen.holds)
        assertTrue(seen.uncounted)
        assertFalse(seen.chosenDelete)
        // Counted alone, a later look says so plainly.
        writer.uncounted -= "slow"
        writer.items["slow"] = 1
        rows.put(seen.copy(chosenDelete = true))
        SaveRuns.interrupted(rows, writer)
        SaveRuns.quietlySettled()
        assertEquals(3, rows.list().single().holds)
        assertFalse(rows.list().single().uncounted)
    }

    /* Another account's row, or one naming none, is never offered, settled, kept, deleted or removed; nothing is sent for it. */
    @Test
    fun anotherAccountsRowIsNeverOfferedSettledKeptOrDeleted() {
        val writer = FakeWriter().apply { live += "node-t"; open += "up-t" }
        val rows = journal()
        // A run's row names the account that made it.
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        assertEquals("me", rows.list().single { it.id == run.id }.account)
        run.finish()
        val theirs = SaveRunRow("theirs", "ws", listOf("node-t"), listOf("up-t"), 1L, "an-earlier-launch", account = "them")
        val nobodys = theirs.copy(id = "nobodys", account = null)
        val finished = theirs.copy(id = "finished", done = true)
        val nodeless = theirs.copy(id = "nodeless", nodeIds = emptyList())
        val answered = theirs.copy(id = "answered", chosenDelete = true, uncertain = mapOf("node-t" to 1L))
        val all = listOf(theirs, nobodys, finished, nodeless, answered)
        for (row in all) rows.put(row)
        assertTrue(SaveRuns.interrupted(rows, writer).isEmpty())
        SaveRuns.quietlySettled()
        // A Delete or a Keep handed one anyway (an older read): as if it weren't there.
        assertEquals(SaveCleanup.NOTHING, SaveRuns.cleanUp(theirs, writer, rows))
        assertEquals(SaveCleanup.NOTHING, SaveRuns.cleanUp(nobodys, writer, rows))
        assertEquals(SaveKeep.GONE, SaveRuns.keep(theirs, writer, rows))
        // Nothing sent, nothing written.
        assertTrue(writer.sent.isEmpty())
        assertTrue(writer.aborted.isEmpty())
        assertTrue("node-t" in writer.live)
        assertEquals(all.map { it.id }.toSet(), rows.list().map { it.id }.toSet())
        for (row in all) assertEquals(row, rows.list().single { it.id == row.id })
        // The same row is that account's own when it is the one signed in.
        writer.account = "them"
        assertEquals(listOf("theirs"), SaveRuns.interrupted(rows, writer).map { it.id })
        SaveRuns.quietlySettled()
        // Nobody signed in: nothing starts.
        writer.account = null
        assertEquals(SaveRunStopped.Reason.SIGNED_OUT, assertThrows(SaveRunStopped::class.java) { SaveRun.start(writer, listOf(opened("f")), emptyList(), rows) }.reason)
    }

    @Test
    fun theNextLaunchFindsAnInterruptedRunDeletesOrKeepsWhatItMadeAndDropsOneItCanNoLongerReach() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        assertTrue(SaveRuns.interrupted(rows, writer).isEmpty())
        val other = SaveRunRow("other", "ws", listOf("node-x"), listOf("up-x"), 1L, "an-earlier-launch", account = "me")
        rows.put(other)
        assertEquals(listOf("other"), SaveRuns.interrupted(rows, writer).map { it.id })
        writer.offline = true
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(other, writer, rows))
        assertTrue(rows.list().any { it.id == "other" })
        // Keep with no answer (offline, an older server): kept all the same (a done mark, never offered); the server lets an
        // open upload expire.
        assertEquals(SaveKeep.KEPT, SaveRuns.keep(other, writer, rows))
        assertFalse(rows.list().any { it.id == "other" && !it.done })
        assertTrue(SaveRuns.interrupted(rows, writer).none { it.id == "other" })
        writer.offline = false
        rows.put(other)
        writer.denied = true
        assertEquals(SaveCleanup.NO_ACCESS, SaveRuns.cleanUp(other, writer, rows))
        assertFalse(rows.list().any { it.id == "other" })
        writer.denied = false
        rows.put(other)
        assertEquals(SaveKeep.KEPT, SaveRuns.keep(other, writer, rows))
        assertTrue("up-x" in writer.aborted)
        assertFalse(rows.list().any { it.id == "other" && !it.done })
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
        SaveRunJournal.endAccount(accountJournal.file.parentFile!!)
        assertFalse(accountJournal.live)
    }

    /*
     * A wipe that comes while a write is under way (between its staging file and the rename): it waits for that write under
     * the file's lock, then deletes; the journal, both its rows included, never comes back.
     */
    @Test
    fun aWipeDuringAWriteLeavesNoJournalBehind() {
        val dir = Files.createTempDirectory("save-runs").toFile()
        val rows = SaveRunJournal(File(dir, SaveRunJournal.FILE))
        rows.put(SaveRunRow("one", "ws", listOf("node-1"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        rows.put(SaveRunRow("two", "ws", listOf("node-2"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        var wiper: Thread? = null
        var wipedMidWrite = false
        rows.staged = {
            rows.staged = null
            wiper = Thread { SaveRunJournal.endAccount(dir) }.also { it.start() }
            // Held mid-write: long enough for a wipe that doesn't wait for the lock to delete first.
            wiper!!.join(300)
            wipedMidWrite = !wiper!!.isAlive
        }
        rows.put(SaveRunRow("one", "ws", listOf("node-1", "node-3"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        wiper!!.join(5_000)
        assertFalse("the wipe deleted the journal while a write was under way", wipedMidWrite)
        assertFalse(File(dir, SaveRunJournal.FILE).exists())
        assertFalse(rows.live)
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
        val pool = Executors.newFixedThreadPool(2)
        val folder = pool.submit<Opened> { run.folder("Archive", own) }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        // The stop's clean-up fails for the file it made and for the folder, whose creation it waits for.
        writer.refuse += "node-1"
        writer.refuse += "made-Archive"
        val cancelling = pool.submit<SaveRunStopped> { run.cancel() }
        Thread.sleep(50)
        go.countDown()
        assertEquals(SaveCleanup.LEFT, cancelling.get(5, TimeUnit.SECONDS).cleanup)
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

    /* Two runs starting at once through separate journals on one file: neither loses the other's row. */
    @Test
    fun journalsOnOneFileNeverLoseEachOthersRows() {
        val file = Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile()
        val session = SaveRunJournal.Epoch()
        val journals = listOf(SaveRunJournal(file, session), SaveRunJournal(file, session))
        val pool = Executors.newFixedThreadPool(8)
        (0 until 200).map { n -> pool.submit { journals[n % 2].put(SaveRunRow("run-$n", "ws", emptyList(), emptyList(), 1L, "l", account = "me")) } }.forEach { it.get() }
        assertEquals(200, journals[0].list().size)
        (0 until 100).map { n -> pool.submit { journals[n % 2].retire(SaveRunRow("run-$n", "ws", emptyList(), emptyList(), 1L, "l", account = "me")) } }.forEach { it.get() }
        assertEquals((100 until 200).map { "run-$it" }.toSet(), journals[1].list().map { it.id }.toSet())
        pool.shutdown()
    }

    /* A finished run whose row the disk won't remove is marked done, never offered for deletion, and dropped later. */
    @Test
    fun aFinishedRunWhoseRowWontGoIsNeverOfferedForDeletion() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        // Every write that would leave the run's row out is refused.
        rows.fault = { written -> if (written.none { it.id == run.id }) throw java.io.IOException("full") }
        run.finish()
        assertTrue(rows.list().single().done)
        rows.fault = null
        rows.put(SaveRunRow(run.id, "ws", listOf("node-1"), emptyList(), 1L, "an-earlier-launch", done = true, account = "me"))
        rows.put(SaveRunRow("other", "ws", listOf("node-x"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        assertEquals(listOf("other"), SaveRuns.interrupted(rows, writer).map { it.id })
        assertEquals(listOf("other"), rows.list().map { it.id })
        assertTrue("node-1" in writer.live)
    }

    /* A folder's id is on disk before its creation goes out, so one created whose answer was lost is still removed. */
    @Test
    fun aFolderWhoseAnswerWasLostIsStillRemovedByItsRow() {
        val writer = FakeWriter().apply { loseAnswer = true }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        assertEquals(SaveRunStopped.Reason.FAILED, assertThrows(SaveRunStopped::class.java) { run.folder("Out", own) }.reason)
        assertEquals(setOf("made-Out"), writer.purged)
        assertTrue(rows.list().isEmpty())
    }

    /*
     * A folder whose creation got no answer, made by the server after the clean-up looked: the row stays and says so, and the
     * next launch removes it. One the server refused with its reason was never made, and the row goes.
     */
    @Test
    fun aFolderWhoseCreationGotNoAnswerKeepsItsRowUntilTheNextLaunchFindsIt() {
        val writer = FakeWriter().apply { createLater = true }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val stopped = assertThrows(SaveRunStopped::class.java) { run.folder("Out", own) }
        writer.live += writer.later
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertFalse(stopped.message.orEmpty().contains("Nothing was saved"))
        assertTrue(stopped.message.orEmpty().contains("You’ll be asked about it next time."))
        val row = rows.list().single()
        assertEquals(listOf("made-Out"), row.nodeIds)
        assertEquals(SaveCleanup.DELETED, SaveRuns.cleanUp(row, writer, rows))
        assertEquals(setOf("made-Out"), writer.purged)
        assertTrue(rows.list().isEmpty())

        // Its own id already taken (an earlier send of the same request made it): it may exist.
        val twice = FakeWriter().apply { refuseCreation = ApiError(409, "An item with this id already exists.", "conflict") }
        val twiceRows = journal()
        val made = SaveRun.start(twice, listOf(opened("f")), emptyList(), twiceRows)
        assertEquals(SaveCleanup.LEFT, assertThrows(SaveRunStopped::class.java) { made.folder("Out", own) }.cleanup)
        assertEquals(listOf("made-Out"), twiceRows.list().single().nodeIds)

        val refused = FakeWriter().apply { refuseCreation = ApiError(409, "The destination folder is in the trash.", "parent-trashed") }
        val other = journal()
        val second = SaveRun.start(refused, listOf(opened("f")), emptyList(), other)
        val said = assertThrows(SaveRunStopped::class.java) { second.folder("Out", own) }
        assertEquals(SaveCleanup.NOTHING, said.cleanup)
        assertTrue(said.message.orEmpty().endsWith("Nothing was saved."))
        assertTrue(other.list().isEmpty())
    }

    /*
     * A cancel that comes between the folder's id going on disk and its creation going out: the creation is counted in the
     * same turn, so the cancel waits for it and removes the folder, though its answer is lost.
     */
    @Test
    fun aCancelInTheGapBeforeAFoldersCreationIsSentStillWaitsForIt() {
        val writer = FakeWriter().apply { loseAnswer = true }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newFixedThreadPool(2)
        var cancel: java.util.concurrent.Future<SaveRunStopped>? = null
        run.registered = {
            cancel = pool.submit<SaveRunStopped> { run.cancel() }
            // Held open: long enough for a cancel that didn't see the creation to finish its clean-up.
            runCatching { cancel!!.get(300, TimeUnit.MILLISECONDS) }
        }
        val folder = pool.submit<Opened> { run.folder("Out", own) }
        runCatching { folder.get(5, TimeUnit.SECONDS) }
        assertEquals(SaveCleanup.DELETED, cancel!!.get(5, TimeUnit.SECONDS).cleanup)
        assertEquals(setOf("made-Out"), writer.purged)
        assertTrue(rows.list().isEmpty())
        pool.shutdown()
    }

    /* A stop waiting for a folder's answer aborts the run's uploads first: none sends a part after the stop began. */
    @Test
    fun aStopWaitingForAFolderAbortsTheRunsUploadsFirst() {
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply {
            parts = 200
            this.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) }
        }
        val begun = CountDownLatch(1)
        writer.beginning = { begun.countDown() }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newFixedThreadPool(3)
        val folder = pool.submit<Opened> { run.folder("Out", own) }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        val file = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(begun.await(5, TimeUnit.SECONDS))
        Thread.sleep(50)
        writer.stopStarted = true
        val cancel = pool.submit<SaveRunStopped> { run.cancel() }
        // The stop waits for the folder; meanwhile the upload would go on sending parts.
        Thread.sleep(300)
        go.countDown()
        cancel.get(5, TimeUnit.SECONDS)
        runCatching { folder.get(5, TimeUnit.SECONDS) }
        runCatching { file.get(5, TimeUnit.SECONDS) }
        // At most the one part already on its way when the stop began.
        assertTrue("${writer.partsAfterStop} parts after the stop began", writer.partsAfterStop <= 1)
        assertTrue(rows.list().isEmpty())
        pool.shutdown()
    }

    /*
     * A journal opened while another writes the same file: it clears a leftover staging file only under the file's lock,
     * so it waits until that write's staging file is renamed over the journal, never deleting it in between.
     */
    @Test
    fun aJournalOpenedMidWriteWaitsBeforeClearingTheStagingFile() {
        val file = Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile()
        val writer = SaveRunJournal(file, SaveRunJournal.Epoch())
        val staging = File(file.parentFile, SaveRunJournal.STAGING)
        var opener: Thread? = null
        var stagedThen = false
        var openedMidWrite = false
        writer.staged = {
            writer.staged = null
            stagedThen = staging.exists()
            opener = Thread { SaveRunJournal(file, SaveRunJournal.Epoch()) }.also { it.start() }
            // Held mid-write: long enough for an open that doesn't wait for the lock to clear the staging file.
            opener!!.join(300)
            openedMidWrite = !opener!!.isAlive
        }
        writer.put(SaveRunRow("run", "ws", listOf("node"), emptyList(), 1L, "now", account = "me"))
        opener!!.join(5_000)
        assertTrue(stagedThen)
        assertFalse("a journal opened mid-write cleared the staging file", openedMidWrite)
        assertEquals(listOf("run"), writer.list().map { it.id })
        assertFalse(staging.exists())
    }

    /*
     * A folder whose creation was on its way when the app ended: the row says so, the next launch doesn't find it and keeps
     * the row, the folder then appears and the launch after removes it. Past the creation window, one still not there was
     * never made.
     */
    @Test
    fun aFolderOnItsWayWhenTheAppEndedKeepsItsRowUntilItAppearsThenGoes() {
        val hold = CountDownLatch(1)
        val writer = FakeWriter().apply { createLater = true; making = { hold.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows, now = { 1_000L })
        val pool = Executors.newSingleThreadExecutor()
        pool.submit { runCatching { run.folder("Out", own) } }
        // The process ends with the creation on its way: the row on disk is all the next launch has.
        var row: SaveRunRow? = null
        repeat(200) { if (row == null) { row = rows.list().firstOrNull { it.nodeIds.isNotEmpty() }; Thread.sleep(5) } }
        val left = row!!.copy(launch = "an-earlier-launch")
        assertEquals(mapOf("made-Out" to 1_000L), left.uncertain)
        // The next launch: the person says delete; not found, the row stays with that answer.
        val later = journal()
        later.put(left)
        assertEquals(listOf(left.id), SaveRuns.interrupted(later, writer, now = 2_000L).map { it.id })
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(left, writer, later, now = 2_000L))
        assertTrue(later.list().single().chosenDelete)
        // Later launches never ask again while the folder isn't there: they only look for it.
        assertTrue(SaveRuns.interrupted(later, writer, now = 2_500L).isEmpty())
        SaveRuns.quietlySettled()
        assertEquals(1, later.list().size)
        // It lands, and someone fills it: the next launch deletes nothing unasked. The answer goes, and the launch after
        // offers the row again with what the folder holds now.
        writer.live += "made-Out"
        writer.items["made-Out"] = 2
        assertTrue(SaveRuns.interrupted(later, writer, now = 3_000L).isEmpty())
        SaveRuns.quietlySettled()
        assertTrue(writer.purged.isEmpty() && writer.trashed.isEmpty())
        val again = SaveRuns.interrupted(later, writer, now = 3_500L).single()
        assertEquals(listOf("made-Out"), again.nodeIds)
        assertEquals(2, again.holds)
        assertFalse(again.chosenDelete)
        // Not found once CREATION_SETTLE_MS has passed: never made, and the row goes quietly.
        writer.live -= "made-Out"
        later.put(again.copy(chosenDelete = true))
        assertTrue(SaveRuns.interrupted(later, writer, now = 1_000L + SaveRuns.CREATION_SETTLE_MS).isEmpty())
        SaveRuns.quietlySettled()
        assertTrue(later.list().isEmpty())
        hold.countDown()
        pool.shutdown()
    }

    /* The rows to offer come back at once: the quiet looks run on their own thread, after. */
    @Test
    fun theRowsToOfferComeBackBeforeAnyQuietLook() {
        val answer = CountDownLatch(1)
        val writer = FakeWriter().apply { looking = { answer.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        rows.put(SaveRunRow("asked", "ws", listOf("n"), emptyList(), 1L, "an-earlier-launch", account = "me"))
        rows.put(SaveRunRow("answered", "ws", listOf("slow"), emptyList(), 1L, "an-earlier-launch", uncertain = mapOf("slow" to 1L), chosenDelete = true, account = "me"))
        val began = System.nanoTime()
        assertEquals(listOf("asked"), SaveRuns.interrupted(rows, writer, now = 2L).map { it.id })
        assertTrue("interrupted waited for a look", System.nanoTime() - began < 1_000_000_000L)
        answer.countDown()
        SaveRuns.quietlySettled()
    }

    /*
     * finish is refused while a result is still being prepared (its folder being listed), never a success; once finished, a
     * stop removes nothing and new work is refused.
     */
    @Test
    fun finishIsRefusedWhileAResultIsBeingPreparedAndOnceFinishedNothingIsRemoved() {
        val listing = CountDownLatch(1)
        val fail = CountDownLatch(1)
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        writer.listing = { listing.countDown(); fail.await(5, TimeUnit.SECONDS); throw Unreachable() }
        val pool = Executors.newSingleThreadExecutor()
        val next = pool.submit<Opened> { run.file(byteArrayOf(2), "b", null, own, folder = opened("g")) }
        assertTrue(listing.await(5, TimeUnit.SECONDS))
        assertThrows(RunBusy::class.java) { run.finish() }
        // The listing fails: the run was never finished, so it stops all or nothing.
        fail.countDown()
        assertTrue(runCatching { next.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause is SaveRunStopped)
        assertThrows(SaveRunStopped::class.java) { run.finish() }
        pool.shutdown()

        // Finished: a cancel after that removes nothing, and new work is refused.
        val other = FakeWriter()
        val done = SaveRun.start(other, listOf(opened("f")), emptyList(), journal())
        done.file(byteArrayOf(1), "a", null, own)
        done.finish()
        assertEquals(SaveRuns.ALREADY_SAVED, done.cancel().message)
        assertTrue("node-1" in other.live)
        assertThrows(SaveRunRefusal::class.java) { done.file(byteArrayOf(2), "b", null, own) }
    }

    /* Two launches' looks never settle one row twice: the second finds it changed and leaves it. */
    @Test
    fun twoOpensLookForAnAnsweredRowOnce() {
        var looks = 0
        val writer = FakeWriter().apply { live += "slow"; looking = { looks++ } }
        val rows = journal()
        rows.put(SaveRunRow("answered", "ws", listOf("slow"), emptyList(), 1L, "an-earlier-launch", uncertain = mapOf("slow" to 1L), chosenDelete = true, account = "me"))
        SaveRuns.interrupted(rows, writer, now = 2L)
        SaveRuns.interrupted(rows, writer, now = 2L)
        SaveRuns.quietlySettled()
        assertEquals(1, looks)
        val row = rows.list().single()
        assertFalse(row.chosenDelete)
        assertEquals(0, row.holds)
    }

    /* A family manager's pause (403 held) is not lost access: the row stays and says so; the launch after the hold cleans up. */
    @Test
    fun aHeldCleanUpKeepsTheRowAndALaterLaunchCleansUp() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        writer.held = true
        val stopped = run.cancel()
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertEquals("Cancelled. Changes are paused in this family, so what was made is still there. You’ll be asked about it next time.", stopped.message)
        assertTrue("node-1" in writer.live)
        val row = rows.list().single()
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(row, writer, rows))
        assertEquals(1, rows.list().size)
        writer.held = false
        assertEquals(SaveCleanup.DELETED, SaveRuns.cleanUp(row, writer, rows))
        assertEquals(setOf("node-1"), writer.purged)
        assertTrue(rows.list().isEmpty())
    }

    /* A sign-out while an interrupted run's clean-up trashes: nothing more is sent, no delete forever. */
    @Test
    fun aSignOutDuringAnInterruptedCleanUpSendsNoDeleteForever() {
        val session = SaveRunJournal.Epoch()
        val rows = journal(session)
        val writer = FakeWriter().apply { live += "node-x"; afterTrash = { session.end() } }
        val row = SaveRunRow("left", "ws", listOf("node-x"), emptyList(), 1L, "an-earlier-launch", account = "me")
        rows.put(row)
        assertEquals(SaveCleanup.LEFT, SaveRuns.cleanUp(row, writer, rows))
        assertEquals(listOf("trash"), writer.sent.toList())
        assertTrue(writer.purged.isEmpty())
    }

    /* A Keep that comes between a quiet look and its write is never undone: compared and written in one hold of the lock. */
    @Test
    fun aKeepBetweenAQuietLookAndItsWriteIsNeverUndone() {
        val rows = journal()
        val answered = SaveRunRow("answered", "ws", listOf("slow"), emptyList(), 1L, "an-earlier-launch", uncertain = mapOf("slow" to 1L), chosenDelete = true, account = "me")
        rows.put(answered)
        // The look finds the folder (filled since); the person's Keep lands on the journal's next access after it, between any
        // read and the write that would follow it.
        val writer = FakeWriter().apply { live += "slow"; items["slow"] = 2 }
        var armed = false
        rows.between = { if (armed) { armed = false; SaveRuns.keep(answered, writer, rows) } }
        writer.looking = { armed = true }
        SaveRuns.interrupted(rows, writer, now = 2L)
        SaveRuns.quietlySettled()
        rows.between = null
        // Only the Keep's mark is left: never offered, dropped at the next launch's look.
        assertEquals(listOf(true), rows.list().map { it.kept && it.done })
        assertTrue(SaveRuns.interrupted(rows, writer, now = 3L).isEmpty())
        assertTrue(rows.list().isEmpty())
    }

    /* Keep on one screen, then Delete from another screen's older read: nothing is trashed or purged, and it says kept. */
    @Test
    fun aDeleteFromAReadBeforeAKeepSendsNothingAndSaysKept() {
        val file = Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile()
        val epoch = SaveRunJournal.Epoch()
        val first = SaveRunJournal(file, epoch)
        val second = SaveRunJournal(file, epoch)
        val made = SaveRunRow("made", "ws", listOf("node-x"), listOf("up-x"), 1L, "an-earlier-launch", account = "me")
        first.put(made)
        val writer = FakeWriter().apply { live += "node-x"; open += "up-x" }
        val stale = SaveRuns.interrupted(second, writer).single()
        assertEquals(SaveKeep.KEPT, SaveRuns.keep(made, writer, first))
        assertEquals(SaveCleanup.KEPT, SaveRuns.cleanUp(stale, writer, second))
        assertEquals(emptyList<String>(), writer.sent.toList())
        assertTrue("node-x" in writer.live)
        // Asked again: still kept, nothing more sent.
        assertEquals(SaveKeep.KEPT, SaveRuns.keep(stale, writer, second))
        assertEquals(emptyList<String>(), writer.sent.toList())
    }

    /* Keep while another screen's Delete is under way waits for it, and never says kept of what went. */
    @Test
    fun aKeepWhileADeleteIsUnderWayWaitsAndNeverSaysKeptOfWhatWent() {
        val rows = journal()
        val made = SaveRunRow("made", "ws", listOf("node-x"), emptyList(), 1L, "an-earlier-launch", account = "me")
        rows.put(made)
        val trashing = CountDownLatch(1)
        val release = CountDownLatch(1)
        val writer = FakeWriter().apply { live += "node-x"; afterTrash = { trashing.countDown(); release.await(10, TimeUnit.SECONDS) } }
        val pool = Executors.newFixedThreadPool(2)
        try {
            val deleting = pool.submit<SaveCleanup> { SaveRuns.cleanUp(made, writer, rows) }
            assertTrue(trashing.await(10, TimeUnit.SECONDS))
            val keeping = pool.submit<SaveKeep> { SaveRuns.keep(made, writer, rows) }
            // Held behind the Delete's lock while its trash request is on its way.
            Thread.sleep(200)
            assertFalse(keeping.isDone)
            release.countDown()
            assertEquals(SaveCleanup.DELETED, deleting.get(10, TimeUnit.SECONDS))
            assertEquals(SaveKeep.GONE, keeping.get(10, TimeUnit.SECONDS))
            assertTrue(rows.list().isEmpty())
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    /* A replace that fails (the rename refused) leaves the old journal as it was, never deleted: its rows are still there. */
    @Test
    fun aRefusedReplaceLeavesTheOldJournalIntact() {
        val rows = journal()
        val kept = SaveRunRow("kept", "ws", listOf("node-1"), emptyList(), 1L, "an-earlier-launch", account = "me")
        rows.put(kept)
        rows.replace = { _, _ -> throw java.io.IOException("rename refused") }
        assertThrows(SaveUnrecorded::class.java) { rows.put(SaveRunRow("next", "ws", listOf("node-2"), emptyList(), 1L, "an-earlier-launch", account = "me")) }
        assertEquals(listOf(kept), SaveRunJournal(rows.file, SaveRunJournal.Epoch()).list())
        assertFalse(File(rows.file.parentFile, SaveRunJournal.STAGING).exists())
    }

    /* finish waits for a folder still being made: the row stays until its creation settles. */
    @Test
    fun finishWaitsForAFolderStillBeingMade() {
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        val folder = pool.submit<Opened> { run.folder("Out", own) }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        assertThrows(RunBusy::class.java) { run.finish() }
        assertEquals(listOf("made-Out"), rows.list().single().nodeIds)
        go.countDown()
        folder.get(5, TimeUnit.SECONDS)
        run.finish()
        assertTrue(rows.list().isEmpty())
        pool.shutdown()
    }

    /* A key change's pause cut short (the thread interrupted) stops the run and removes what it made, as any failure does. */
    @Test
    fun aPauseCutShortStopsTheRunAndCleansUp() {
        val writer = FakeWriter()
        writer.answers.addLast { throw ApiError(409, "Finishing a key change…", "rotating") }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), rows, pause = { throw InterruptedException() })
        run.folder("Out", own)
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }
        assertEquals(SaveRunStopped.Reason.FAILED, stopped.reason)
        assertTrue(Thread.interrupted())
        assertEquals(setOf("made-Out"), writer.purged)
        assertTrue(rows.list().isEmpty())
    }

    /* A listing that fails after a result landed stops the run and removes it: all or nothing. */
    @Test
    fun aListingThatFailsStopsTheRunAndRemovesWhatItMade() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        writer.namesFail = true
        assertEquals(SaveRunStopped.Reason.FAILED, assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "b", null, own, folder = opened("g")) }.reason)
        assertEquals(setOf("node-1"), writer.purged)
        assertTrue(rows.list().isEmpty())
        assertThrows(SaveRunStopped::class.java) { run.folder("Out", own) }
    }

    /* A clean-up that leaves a published file says what may remain, never "nothing was saved". */
    @Test
    fun aCleanUpThatLeavesAFileSaysWhatMayRemain() {
        val writer = FakeWriter()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        run.file(byteArrayOf(1), "a", null, own)
        writer.refuse += "node-1"
        val stopped = run.cancel()
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertEquals("Cancelled. Some of what was made may still be there. You’ll be asked about it next time.", stopped.message)
    }

    /* The network went while a version's parts went up: its completion was never sent, so it isn't said to maybe be saved. */
    @Test
    fun aVersionWhoseCompletionWasNeverSentIsNotSaidToMaybeBeSaved() {
        val doc = opened("doc", parent = "f", version = "v1")
        val uploading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.uploading = { uploading.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(doc), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<VersionSaved> { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
        assertTrue(uploading.await(5, TimeUnit.SECONDS))
        writer.offline = true
        val stopped = run.cancel()
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertEquals(0, stopped.uncertainVersions)
        assertEquals(SaveRuns.CANCELLED, stopped.message)
        assertEquals(listOf(listOf("up-1")), rows.list().map { it.uploadIds })
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
        pool.shutdown()
    }

    /*
     * A begin still on its way at the cancel: when it answers, the stopped run refuses it, so nothing is sent and the
     * reservation is aborted (never a file completed that no row names). Fails if a sealed run lets a late begin go on.
     */
    @Test
    fun aBeginAnsweredAfterTheRunStoppedIsAbortedNeverCompleted() {
        val beginning = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.beginning = { beginning.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(beginning.await(5, TimeUnit.SECONDS))
        assertEquals(SaveCleanup.NOTHING, run.cancel().cleanup)
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
        assertTrue(writer.live.isEmpty())
        assertEquals(0, writer.partsSent)
        assertEquals(listOf("up-1"), writer.aborted)
        assertTrue(rows.list().isEmpty())
        pool.shutdown()
    }

    /* A completion about to go out after the run stopped is refused: the upload is aborted, nothing lands. */
    @Test
    fun aCompletionAfterTheRunStoppedIsNeverSent() {
        val doc = opened("doc", parent = "f", version = "v1")
        val uploading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.uploading = { uploading.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val run = SaveRun.start(writer, listOf(doc), emptyList(), journal())
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<VersionSaved> { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
        assertTrue(uploading.await(5, TimeUnit.SECONDS))
        assertEquals(SaveRuns.CANCELLED, run.cancel().message)
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
        assertTrue(writer.finished.isEmpty())
        pool.shutdown()
    }

    /* A finish whose record the disk won't update says so, takes nothing more, and can be asked again; Keep the same. */
    @Test
    fun aFinishWhoseRecordWontUpdateSaysSoAndCanBeAskedAgain() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        rows.fault = { throw java.io.IOException("full") }
        assertThrows(SaveRecordNotUpdated::class.java) { run.finish() }
        assertThrows(SaveRunRefusal::class.java) { run.file(byteArrayOf(1), "b", null, own) }
        rows.fault = null
        run.finish()
        assertTrue(rows.list().isEmpty())
        val other = SaveRunRow("other", "ws", emptyList(), emptyList(), 1L, "an-earlier-launch", account = "me")
        rows.put(other)
        rows.fault = { throw java.io.IOException("full") }
        assertThrows(SaveRecordNotUpdated::class.java) { SaveRuns.keep(other, writer, rows) }
        rows.fault = null
        assertEquals(listOf("other"), rows.list().map { it.id })
    }

    /* What a stop says comes from what was sent: a sign-out after a completion, a cancel after finish, a denied abort, a reason. */
    @Test
    fun whatAStopSaysComesFromWhatWasSent() {
        val landing = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.landing = { landing.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val session = SaveRunJournal.Epoch()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal(session))
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(landing.await(5, TimeUnit.SECONDS))
        SaveRuns.abandonAll(session)
        go.countDown()
        val thrown = runCatching { saving.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause as SaveRunStopped
        assertEquals("You signed out before this was saved. Some of what was made may still be there.", thrown.message)

        val done = SaveRun.start(FakeWriter(), listOf(opened("f")), emptyList(), journal())
        done.file(byteArrayOf(1), "a", null, own)
        done.finish()
        assertEquals(SaveRuns.ALREADY_SAVED, done.cancel().message)

        val doc = opened("doc", parent = "f", version = "v1")
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val denied = FakeWriter().apply { this.landing = { held.countDown(); release.await(5, TimeUnit.SECONDS) } }
        val versions = SaveRun.start(denied, listOf(doc), emptyList(), journal())
        val saved = pool.submit<VersionSaved> { versions.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        denied.denied = true
        assertEquals(1, versions.cancel().uncertainVersions)
        release.countDown()
        runCatching { saved.get(5, TimeUnit.SECONDS) }

        val listing = FakeWriter().apply { namesFail = true }
        val failing = SaveRun.start(listing, listOf(opened("f")), emptyList(), journal())
        val stopped = assertThrows(SaveRunStopped::class.java) { failing.file(byteArrayOf(1), "a", null, own) }
        assertEquals("${SaveRuns.sentence(Unreachable().message ?: "")} Nothing was saved.", stopped.message)
        pool.shutdown()
    }

    /* A cancel that overtakes a folder's creation waits for its answer: a folder made after the clean-up looked is still removed. */
    @Test
    fun aCancelThatOvertakesAFoldersCreationWaitsForIt() {
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply {
            loseAnswer = true
            this.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) }
        }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newFixedThreadPool(2)
        val folder = pool.submit<Opened> { run.folder("Out", own) }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        val cancel = pool.submit<SaveRunStopped> { run.cancel() }
        Thread.sleep(50)
        go.countDown()
        assertEquals(SaveCleanup.DELETED, cancel.get(5, TimeUnit.SECONDS).cleanup)
        runCatching { folder.get(5, TimeUnit.SECONDS) }
        assertEquals(setOf("made-Out"), writer.purged)
        assertTrue(rows.list().isEmpty())
        pool.shutdown()
    }

    /* A stop interrupted while it waits for a folder's creation: its outcome is settled, the interrupt kept, the row left for later. */
    @Test
    fun aStopInterruptedWhileItWaitsSettlesItsOutcomeAndLaterCallsReturn() {
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        writer.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) }
        val pool = Executors.newFixedThreadPool(3)
        try {
            val folder = pool.submit<Opened> { run.folder("Out", own) }
            assertTrue(making.await(5, TimeUnit.SECONDS))
            var stopped: SaveRunStopped? = null
            var stillInterrupted = false
            val stopper = Thread {
                stopped = run.cancel()
                stillInterrupted = Thread.currentThread().isInterrupted
            }
            stopper.start()
            Thread.sleep(100)
            stopper.interrupt()
            stopper.join(5_000)
            assertFalse(stopper.isAlive)
            assertTrue(stillInterrupted)
            assertEquals(SaveCleanup.LEFT, stopped?.cleanup)
            assertTrue(stopped?.message.orEmpty(), stopped?.message.orEmpty().contains("asked about it next time"))
            // Later calls return the settled outcome instead of waiting on it.
            val later = pool.submit<SaveRunStopped> { run.cancel() }
            assertEquals(stopped, later.get(5, TimeUnit.SECONDS))
            val finishing = pool.submit<Unit> { run.finish() }
            val thrown = runCatching { finishing.get(5, TimeUnit.SECONDS) }.exceptionOrNull()
            assertTrue(thrown.toString(), thrown?.cause is SaveRunStopped)
            // Nothing was removed: the row still names what was made, for the next launch.
            assertTrue(writer.purged.isEmpty())
            assertEquals(listOf("node-1"), rows.list().single().nodeIds.take(1))
            go.countDown()
            runCatching { folder.get(5, TimeUnit.SECONDS) }
        } finally {
            go.countDown()
            pool.shutdownNow()
        }
    }

    /* A stop interrupted in an abort's pause: the interrupt is kept, the outcome settled, nothing removed, the row left for later. */
    @Test
    fun aStopInterruptedInAnAbortsPauseSettlesItsOutcomeAndRemovesNothing() {
        val uploading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val pausing = CountDownLatch(1)
        val writer = FakeWriter().apply { this.uploading = { uploading.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
            assertTrue(uploading.await(5, TimeUnit.SECONDS))
            writer.abortPause = { pausing.countDown(); Thread.sleep(10_000) }
            var stopped: SaveRunStopped? = null
            var stillInterrupted = false
            val stopper = Thread {
                stopped = run.cancel()
                stillInterrupted = Thread.currentThread().isInterrupted
            }
            stopper.start()
            assertTrue(pausing.await(5, TimeUnit.SECONDS))
            stopper.interrupt()
            stopper.join(5_000)
            assertFalse(stopper.isAlive)
            assertTrue(stillInterrupted)
            assertEquals(SaveCleanup.LEFT, stopped?.cleanup)
            // Its new file's completion never went out: nothing may be there to promise a prompt for.
            assertEquals(SaveRuns.words(SaveRunStopped.Reason.CANCELLED, false, null, 0, 0, null), stopped?.message)
            writer.abortPause = null
            assertEquals(stopped, pool.submit<SaveRunStopped> { run.cancel() }.get(5, TimeUnit.SECONDS))
            assertTrue(writer.sent.none { it == "trash" || it == "purge" })
            assertEquals(listOf("up-1"), rows.list().single().uploadIds)
            go.countDown()
            runCatching { saving.get(5, TimeUnit.SECONDS) }
        } finally {
            go.countDown()
            pool.shutdownNow()
        }
    }

    /*
     * A stop cut short while a version's completion had gone out says that version may have been saved, and promises no
     * prompt next time: a row with only uploads is settled quietly, never offered.
     */
    @Test
    fun aStopCutShortAfterAVersionsCompletionSaysItMayHaveLandedAndPromisesNoPrompt() {
        val landing = CountDownLatch(1)
        val go = CountDownLatch(1)
        val pausing = CountDownLatch(1)
        val writer = FakeWriter().apply { this.landing = { landing.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val doc = opened("doc", "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), emptyList(), journal())
        val pool = Executors.newFixedThreadPool(2)
        try {
            val saving = pool.submit<VersionSaved> { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
            assertTrue(landing.await(5, TimeUnit.SECONDS))
            writer.abortPause = { pausing.countDown(); Thread.sleep(10_000) }
            var stopped: SaveRunStopped? = null
            val stopper = Thread { stopped = run.cancel() }
            stopper.start()
            assertTrue(pausing.await(5, TimeUnit.SECONDS))
            stopper.interrupt()
            stopper.join(5_000)
            assertEquals(1, stopped?.uncertainVersions)
            assertFalse(stopped?.message.orEmpty(), stopped?.message.orEmpty().contains("next time"))
            assertTrue(stopped?.message.orEmpty(), stopped?.message.orEmpty().contains("may have been saved"))
            writer.abortPause = null
            go.countDown()
            runCatching { saving.get(5, TimeUnit.SECONDS) }
        } finally {
            go.countDown()
            pool.shutdownNow()
        }
    }

    /* The abort helper never swallows an interrupt; any other failure is an unknown answer. */
    @Test
    fun anAbortCutShortByAnInterruptIsThrownAndAnyOtherFailureIsUnknown() {
        val writer = FakeWriter().apply { abortPause = { throw InterruptedException() } }
        assertThrows(InterruptedException::class.java) { SaveRuns.abort(writer, "up-x", "ws") }
        writer.abortPause = { throw IllegalStateException("no answer") }
        assertEquals(SaveAbortFate.UNKNOWN, SaveRuns.abort(writer, "up-x", "ws"))
        writer.abortPause = { throw InterruptedException() }
        // A trash cut short by an interrupt is thrown on too, never taken for "left".
        val trashing = FakeWriter().apply { live += "node-x"; afterTrash = { throw InterruptedException() } }
        assertThrows(InterruptedException::class.java) { SaveRuns.discard(listOf("node-x"), "ws", trashing, stillOn = { true }) }
        // Through a clean-up too: the interrupt reaches its caller.
        assertThrows(InterruptedException::class.java) {
            SaveRuns.clean(SaveRunRow("r", "ws", emptyList(), listOf("up-x"), 1L, "l", account = "me"), writer, journal(), emptySet(), null, null, stillOn = { true })
        }
    }

    /*
     * Signed out before the clean-up asks anything: a version whose completion was sent and whose abort answered "not found"
     * may have landed (a share that ended answers 404 too), so it is said to maybe be saved; one the abort released is not.
     */
    @Test
    fun aSignOutCountsAVersionWhoseSentCompletionAbortedAsNotFoundAsMaybeSaved() {
        val writer = FakeWriter()
        val row = SaveRunRow("r", "ws", emptyList(), listOf("up-gone", "up-aborted"), 1L, "l", account = "me")
        val both = setOf("up-gone", "up-aborted")
        val asked = mapOf("up-gone" to SaveAbortFate.GONE, "up-aborted" to SaveAbortFate.ABORTED)
        val cleaned = SaveRuns.clean(row, writer, journal(), both, both, emptySet(), asked, stillOn = { false })
        assertEquals(SaveCleanup.LEFT, cleaned.cleanup)
        assertEquals(1, cleaned.uncertain)
        assertTrue(writer.sent.isEmpty())
    }

    /* A journal file it can't read is never written over: the other runs' rows in it stay, and every write is refused. */
    @Test
    fun anUnreadableJournalIsNeverWrittenOver() {
        val file = Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile()
        val rows = SaveRunJournal(file, SaveRunJournal.Epoch())
        val other = SaveRunRow("other", "ws", listOf("node-x"), emptyList(), 1L, "an-earlier-launch", account = "me")
        rows.put(other)
        // Cut short (a write torn by something outside this app), or unreadable: not "no rows".
        val torn = file.readText().dropLast(5)
        file.writeText(torn)
        assertThrows(SaveJournalUnreadable::class.java) { rows.list() }
        assertThrows(SaveUnrecorded::class.java) { rows.put(SaveRunRow("next", "ws", listOf("node-y"), emptyList(), 1L, "l", account = "me")) }
        assertFalse(rows.retire(other))
        assertFalse(rows.swap(other, null))
        rows.dropDone("me")
        assertEquals(torn, file.readText())
        // A run refuses to start rather than publish what no row names.
        assertThrows(SaveRunStopped::class.java) { SaveRun.start(FakeWriter(), listOf(opened("f")), emptyList(), rows) }
        assertEquals(torn, file.readText())
        // Only a journal that isn't there is empty.
        file.delete()
        assertEquals(emptyList<SaveRunRow>(), rows.list())
    }

    /* A raw failure's own text (a path, a parser's words) is never what a stopped run says; the server's and the app's words are. */
    @Test
    fun aRawFailureIsNeverSaidInItsOwnWords() {
        val writer = FakeWriter()
        writer.folderAnswers.addLast { throw IllegalStateException("/data/user/0/com.hushos.app/files/save-runs.json: open failed: EACCES") }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        val stopped = assertThrows(SaveRunStopped::class.java) { run.folder("Out", own) }
        assertFalse(stopped.message.orEmpty().contains("/data"))
        assertEquals(SaveRuns.words(SaveRunStopped.Reason.FAILED, false, null, 0), stopped.message)
        // The server's own sentence is still said.
        assertEquals("Not allowed here.", SaveRuns.reason(ApiError(403, "Not allowed here.")))
        assertEquals(null, SaveRuns.reason(java.io.IOException("/data/x: ENOSPC")))
    }

    /* An upload begun in another workspace than the run's is never recorded, and the run stops. */
    @Test
    fun anUploadBegunInAnotherWorkspaceIsNeverRecorded() {
        val writer = FakeWriter().apply { beginWorkspace = "ws-elsewhere" }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }
        assertEquals(SaveRunStopped.Reason.FAILED, stopped.reason)
        assertTrue(rows.list().none { "node-1" in it.nodeIds })
        assertTrue(writer.purged.isEmpty())
    }

    /* A key change's re-listing that names another folder than the run's never becomes where results are saved. */
    @Test
    fun aReListingNamingAnotherFolderNeverBecomesTheDestination() {
        val writer = FakeWriter().apply { refreshedAs = opened("elsewhere") }
        writer.answers.addLast { throw ApiError(409, "Finishing a key change…", "rotating") }
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), journal(), pause = {})
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(stopped.message.orEmpty(), stopped.message.orEmpty().contains(SaveRuns.DESTINATION_CHANGED))
        assertEquals(1, writer.uploads.size)
    }

    /* A pause that kept only a version's reservation keeps the row but never says what was made is still there. */
    @Test
    fun aPauseThatKeptOnlyAVersionsReservationSaysNothingRemains() {
        val uploading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.uploading = { uploading.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val rows = journal()
        val doc = opened("doc", "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), emptyList(), rows)
        val pool = Executors.newSingleThreadExecutor()
        try {
            val saving = pool.submit<VersionSaved> { run.version(byteArrayOf(1), doc, opened("f"), "v1", own) }
            assertTrue(uploading.await(5, TimeUnit.SECONDS))
            writer.held = true
            val stopped = run.cancel()
            assertEquals(SaveCleanup.LEFT, stopped.cleanup)
            assertFalse(stopped.message.orEmpty(), stopped.message.orEmpty().contains("still there"))
            assertTrue(rows.list().single().uploadIds.isNotEmpty())
            go.countDown()
            runCatching { saving.get(5, TimeUnit.SECONDS) }
        } finally {
            go.countDown()
            pool.shutdownNow()
        }
    }

    /* A result asked into another Drive than the run's is refused before anything is listed, minted or sent. */
    @Test
    fun aResultIntoAnotherDriveThanTheRunsIsRefusedBeforeAnythingIsSent() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        val elsewhere = opened("b", workspace = "ws-other")
        assertEquals(SaveRuns.OUTSIDE_RUN, assertThrows(SaveRunRefusal::class.java) { run.file(byteArrayOf(1), "a", null, own, folder = elsewhere) }.message)
        assertEquals(SaveRuns.OUTSIDE_RUN, assertThrows(SaveRunRefusal::class.java) { run.folder("Out", own, elsewhere) }.message)
        assertEquals(SaveRuns.OUTSIDE_RUN, assertThrows(SaveRunRefusal::class.java) {
            run.version(byteArrayOf(1), opened("doc", "b", version = "v1", workspace = "ws-other"), elsewhere, "v1", own)
        }.message)
        assertTrue(writer.uploads.isEmpty())
        assertTrue(writer.folderEpochs.isEmpty())
        assertEquals(emptyList<String>(), rows.list().single().nodeIds)
        // The run itself goes on.
        run.file(byteArrayOf(1), "b", null, own)
        assertEquals(1, writer.uploads.size)
        run.cancel()
    }

    /* A sign-out while a stop waits for a folder's creation: nothing more is asked of the server, and it says what may stay. */
    @Test
    fun aSignOutWhileAStopWaitsSendsNothingMoreAndSaysWhatMayStay() {
        val making = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter()
        val session = SaveRunJournal.Epoch()
        val rows = journal(session)
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), rows)
        run.file(byteArrayOf(1), "a", null, own)
        writer.making = { making.countDown(); go.await(5, TimeUnit.SECONDS) }
        val pool = Executors.newFixedThreadPool(2)
        try {
            val folder = pool.submit<Opened> { run.folder("Out", own) }
            assertTrue(making.await(5, TimeUnit.SECONDS))
            val cancel = pool.submit<SaveRunStopped> { run.cancel() }
            Thread.sleep(50)
            // Signed out while the stop waits for the creation to settle.
            session.end()
            go.countDown()
            val stopped = cancel.get(5, TimeUnit.SECONDS)
            runCatching { folder.get(5, TimeUnit.SECONDS) }
            assertEquals(emptyList<String>(), writer.sent.filter { it == "trash" || it == "purge" })
            assertTrue(writer.purged.isEmpty())
            assertEquals(SaveCleanup.LEFT, stopped.cleanup)
            assertTrue(stopped.message, stopped.message.orEmpty().contains("may still be there"))
        } finally {
            go.countDown()
            pool.shutdownNow()
        }
    }

    /* An offline clean-up of a file whose completion was never sent doesn't say it may still be there. */
    @Test
    fun anOfflineCleanUpOfAFileNeverCompletedSaysNothingRemains() {
        val uploading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val writer = FakeWriter().apply { this.uploading = { uploading.countDown(); go.await(5, TimeUnit.SECONDS) } }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), journal())
        val pool = Executors.newSingleThreadExecutor()
        val saving = pool.submit<Opened> { run.file(byteArrayOf(1), "a", null, own) }
        assertTrue(uploading.await(5, TimeUnit.SECONDS))
        writer.offline = true
        val stopped = run.cancel()
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        assertEquals(SaveRuns.CANCELLED, stopped.message)
        go.countDown()
        runCatching { saving.get(5, TimeUnit.SECONDS) }
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

    /*
     * The client never sends a write again by itself (DriveApi.sentOnce): a write whose answer is lost is Unreachable.
     * Only writes safe to repeat are sent once more, by the app, on a fresh connection: a folder creation (by its minted
     * id), an abort, a trash batch.
     */
    @Test
    fun aWriteWhoseAnswerIsLostIsSentOnceAndOnlyASafeOneOnceMore() {
        server.dropReply = { method, path -> method == "POST" && (path.endsWith("/epochs") || path == "drive/folders" || path.endsWith("/trash-batch")) }
        assertThrows(Unreachable::class.java) { vault.api.allocateEpoch(vault.workspaceId) }
        assertEquals(1, server.requests.count { it.endsWith("/epochs") })
        assertThrows(Unreachable::class.java) { vault.api.trashBatch(vault.workspaceId, listOf(server.root)) }
        assertEquals(2, server.requests.count { it.endsWith("/trash-batch") })
        server.dropReply = null
    }

    /*
     * A folder creation whose answer is lost, sent once more and refused for anything but its own id (here a 429): the
     * first send may still be made, so it stays unanswered, and a run keeps the folder uncertain in its row.
     */
    @Test
    fun aFolderCreationWhoseRetryIsRefusedStaysUnanswered() {
        var dropped = false
        server.dropReply = { method, path -> (method == "POST" && path == "drive/folders" && !dropped).also { if (it) dropped = true } }
        var sends = 0
        // The first send is cut while the server is still at it (not made yet); the second is refused 429.
        server.extraRoutes = { method, segments, _, body ->
            when {
                method == "POST" && segments == listOf("drive", "folders") ->
                    if (++sends == 1) 200 to JSONObject() else 429 to JSONObject().put("message", "Slow down.")
                // The clean-up's look: not there (yet).
                method == "POST" && segments.lastOrNull() == "trash-batch" -> {
                    val ids = body.getJSONArray("nodeIds")
                    200 to JSONObject().put("results", org.json.JSONArray((0 until ids.length()).map { i ->
                        JSONObject().put("id", ids.getString(i)).put("status", "refused").put("reason", "not-found")
                    }))
                }
                else -> null
            }
        }
        val file = Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile()
        val rows = SaveRunJournal(file, SaveRunJournal.Epoch())
        val root = vault.resolve(server.root)
        val run = SaveRun.start(VaultSaveWriter(vault) { StorageAllowance(1L shl 40, 0L, 1L shl 40) }, listOf(root), emptyList(), rows, pause = {})
        val stopped = assertThrows(SaveRunStopped::class.java) { run.folder("Out", SaveSources.OwnWriting) }
        assertEquals(2, sends)
        assertEquals(SaveCleanup.LEFT, stopped.cleanup)
        val row = rows.list().single()
        assertEquals(1, row.nodeIds.size)
        assertEquals(row.nodeIds.toSet(), row.uncertain.keys)
        server.dropReply = null
        server.extraRoutes = null
    }

    /*
     * A folder creation whose answer is lost and whose second send names nothing (a sign-out's 401; its own id taken, but the
     * listing refused or not naming it) stays unanswered: the first send may still be made, never settled as not made.
     */
    @Test
    fun aFolderCreationsRetryThatNamesNothingLeavesTheFirstSendUnanswered() {
        val conflict = 409 to JSONObject().put("code", "conflict").put("message", "Taken.")
        val cases = listOf(
            (401 to JSONObject().put("message", "Sign in.")) to null,
            conflict to (403 to JSONObject().put("code", "forbidden").put("message", "No.")),
            conflict to (200 to null),
        )
        for ((second, listing) in cases) {
            var dropped = false
            server.dropReply = { method, path -> (method == "POST" && path == "drive/folders" && !dropped).also { if (it) dropped = true } }
            var sends = 0
            server.extraRoutes = { method, segments, _, _ ->
                when {
                    method == "POST" && segments == listOf("drive", "folders") -> if (++sends == 1) 200 to JSONObject() else second
                    method == "GET" && segments.lastOrNull() == "children" && listing?.second != null -> listing.first to listing.second!!
                    else -> null
                }
            }
            val folder = JSONObject().put("id", "minted-folder").put("parentId", server.root)
            assertThrows(Unreachable::class.java) { vault.api.createFolder(vault.workspaceId, folder) }
            assertEquals(2, sends)
        }
        server.dropReply = null
        server.extraRoutes = null
    }

    /*
     * A folder this device created is filed as it sent it: the reply's parent, key epochs and envelopes are ignored (only the
     * server's own fields, such as its change number, are taken), and a reply naming another folder is no answer.
     */
    @Test
    fun aCreatedFolderIsFiledAsItWasSentNeverAsTheReplyDescribesIt() {
        fun reply(folder: JSONObject, id: String = folder.getString("id")) = JSONObject().put("nodes", org.json.JSONArray().put(
            JSONObject().put("id", id).put("workspaceId", vault.workspaceId).put("parentId", "someone-elses-folder").put("kind", "folder")
                .put("keyEpoch", 99).put("parentKeyEpoch", 42).put("keyEnvelope", "theirs").put("metadataVersion", 1)
                .put("metadataEnvelope", "theirs-too").put("currentVersion", JSONObject.NULL).put("trashedAt", JSONObject.NULL)
                .put("createdAt", "2026-11-18T00:00:00Z").put("updatedAt", "2026-11-18T00:00:00Z").put("changeSeq", 7)))
        var sent: JSONObject? = null
        server.extraRoutes = { method, segments, _, body ->
            if (method == "POST" && segments == listOf("drive", "folders")) {
                sent = body.getJSONArray("folders").getJSONObject(0)
                200 to reply(sent!!)
            } else null
        }
        val made = vault.createFolder(server.root, "Out")
        val asSent = sent!!
        assertEquals(server.root, made.node.parentId)
        assertEquals(asSent.getLong("keyEpoch").toULong(), made.node.keyEpoch)
        assertEquals(asSent.getLong("parentKeyEpoch").toULong(), made.node.parentKeyEpoch)
        assertEquals(asSent.getString("keyEnvelope"), made.node.keyEnvelope)
        assertEquals(asSent.getString("metadataEnvelope"), made.node.metadataEnvelope)
        assertEquals("Out", made.name)
        // The server's own field is taken.
        assertEquals(7, made.node.changeSeq)
        // The row this device keeps says the same, its stored JSON included.
        val held = vault.nodes.row(vault.workspaceId, made.id)!!
        assertEquals(server.root, held.node.parentId)
        assertEquals(asSent.getString("keyEnvelope"), JSONObject(held.node.rawJson).getString("keyEnvelope"))
        // A reply naming another folder is no answer.
        server.extraRoutes = { method, segments, _, body ->
            if (method == "POST" && segments == listOf("drive", "folders")) 200 to reply(body.getJSONArray("folders").getJSONObject(0), "another-folder")
            else null
        }
        assertThrows(ApiError::class.java) { vault.createFolder(server.root, "Again") }
        assertEquals(null, vault.nodes.row(vault.workspaceId, "another-folder"))
        server.extraRoutes = null
    }

    /* On a server without the batch route, a clean-up's trash goes one request an item, the session asked before each. */
    @Test
    fun aCleanUpOnAServerWithoutTheBatchRouteTrashesOneItemAtATime() {
        val id = server.file(server.root, "doc.txt", "first".toByteArray())
        val other = server.file(server.root, "other.txt", "second".toByteArray())
        vault.listChildren(server.root)
        server.extraRoutes = { method, segments, _, _ ->
            when {
                method == "POST" && segments.lastOrNull() == "trash-batch" -> 501 to JSONObject().put("code", "unsupported").put("message", "Not here.")
                method == "POST" && segments.lastOrNull() == "trash" && segments.getOrNull(2)?.startsWith("nope") == true ->
                    404 to JSONObject().put("code", "not-found").put("message", "This item no longer exists.")
                else -> null
            }
        }
        val epoch = SaveRunJournal.Epoch()
        val writer = VaultSaveWriter(vault, epoch) { throw IllegalStateException("not asked") }
        // Every item not found, one by one: not made yet or out of reach, and nothing tells which. Uncertain (refused, the row
        // kept), never lost access and never gone.
        assertEquals(setOf(SaveItemFate.REFUSED), writer.trash(listOf("nope-1", "nope-2"), vault.workspaceId).values.toSet())
        val fates = writer.trash(listOf(id), vault.workspaceId)
        assertEquals(SaveItemFate.DONE, fates[id])
        val batches = server.requests.count { it.endsWith("/trash-batch") }
        assertEquals(2, batches)
        assertEquals(1, server.requests.count { it.endsWith("/nodes/$id/trash") })
        // Signed out: nothing more is sent, one item or another.
        epoch.end()
        assertEquals(SaveItemFate.REFUSED, writer.trash(listOf(other), vault.workspaceId)[other])
        assertTrue(server.requests.none { it.endsWith("/nodes/$other/trash") })
        server.extraRoutes = null
    }

    /*
     * Whether a clean-up may delete forever: true for the own Drive; not known (null, the row kept) for a workspace that is
     * neither the own nor a family this device knows nor a share the server lists; never false before that is confirmed.
     */
    @Test
    fun mayDeleteForeverIsUnknownUntilConfirmed() {
        val writer = VaultSaveWriter(vault) { throw IllegalStateException("not asked") }
        assertEquals(true, writer.mayPurge(vault.workspaceId))
        assertEquals(null, writer.mayPurge("0b6c0f4e-0000-4000-8000-00000000beef"))
        // No answer about shares: not known either, never false.
        server.extraRoutes = { method, segments, _, _ -> if (method == "GET" && segments.lastOrNull() == "shares") 503 to JSONObject() else null }
        assertEquals(null, writer.mayPurge("0b6c0f4e-0000-4000-8000-00000000beef"))
        server.extraRoutes = null
    }

    /* An abort answered 401 (an expired session) says nothing of the upload: no answer, its id kept. */
    @Test
    fun anAbortAnswered401IsNoAnswer() {
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "abort") 401 to JSONObject().put("message", "Sign in.") else null
        }
        assertEquals(SaveAbortFate.UNKNOWN, vault.api.abortUploadFate("up-x", vault.workspaceId))
        server.extraRoutes = null
    }

    /* A run that stops while its completion is being sent again (the first answer lost) sends it no more, and aborts nothing blind. */
    @Test
    fun aRunThatStopsWhileACompletionIsRetriedSendsItNoMore() {
        val before = Resumable.pause
        Resumable.pause = {}
        try {
            // Every completion's answer lost: it is asked again after a pause.
            server.dropReply = { method, path -> method == "POST" && path.endsWith("/complete") }
            var asked = 0
            val thrown = runCatching {
                vault.uploadResult("tool output".toByteArray(), "out.txt", "text/plain", server.root, null, null, copy = null,
                    onCompleting = { if (asked++ > 0) throw IllegalStateException("This save run is stopping.") })
            }.exceptionOrNull()
            assertTrue(thrown.toString(), thrown is IllegalStateException)
            assertEquals(2, asked)
            assertEquals(1, server.requests.count { it.endsWith("/complete") })
            // The first send may have landed: never aborted blind.
            assertTrue(server.requests.none { it.endsWith("/abort") })
        } finally {
            Resumable.pause = before
            server.dropReply = null
        }
    }

    /* The vault's writer refuses a destination it holds under another workspace than the one asked, before anything is sent. */
    @Test
    fun aDestinationNotHeldUnderItsOwnWorkspaceIsRefusedBeforeAnythingIsSent() {
        vault.listChildren(server.root)
        val writer = VaultSaveWriter(vault) { StorageAllowance(1L shl 40, 0L, 1L shl 40) }
        val sent = server.requests.size
        // The own root's id, named as another workspace's row.
        val real = vault.resolve(server.root)
        val shared = Opened(real.node.copy(workspaceId = "0b6c0f4e-0000-4000-8000-00000000beef"), real.metadata)
        assertThrows(FamilyFailure::class.java) { writer.makeFolder(shared, "Out", null) {} }
        assertThrows(FamilyFailure::class.java) {
            writer.uploadResult(byteArrayOf(1), "a", null, shared, null, null, null, null, onBegun = {}, onCompleting = {})
        }
        assertEquals(sent, server.requests.size)
    }

    /*
     * A run's folder is made under the very row its destination was checked as, never one its id looks up again: the own
     * Drive's folder of the same id is not that row, so nothing is minted, wrapped or sent.
     */
    @Test
    fun aFolderIsMadeUnderTheRowCheckedNeverOneItsIdLooksUpAgain() {
        vault.listChildren(server.root)
        val sent = server.requests.size
        val real = vault.resolve(server.root)
        val shared = Opened(real.node.copy(workspaceId = "0b6c0f4e-0000-4000-8000-00000000beef"), real.metadata)
        var minted = 0
        assertThrows(FamilyFailure::class.java) { vault.createFolder(shared, "Out", null) { minted++ } }
        assertEquals(sent, server.requests.size)
        assertEquals(0, minted)
        // The row held as it was checked is the one written under.
        val made = vault.createFolder(real, "In", null) { minted++ }
        assertEquals(server.root, made.node.parentId)
        assertEquals(1, minted)
    }

    /* A run's new file is begun under the very row its destination was checked as, never one its id looks up again. */
    @Test
    fun aNewFileIsBegunUnderTheRowCheckedNeverOneItsIdLooksUpAgain() {
        vault.listChildren(server.root)
        val sent = server.requests.size
        val real = vault.resolve(server.root)
        val shared = Opened(real.node.copy(workspaceId = "0b6c0f4e-0000-4000-8000-00000000beef"), real.metadata)
        var begun = 0
        assertThrows(FamilyFailure::class.java) {
            vault.uploadResult(byteArrayOf(1), "a.txt", null, shared.id, null, null, null, onBegun = { begun++ }, held = shared)
        }
        assertEquals(sent, server.requests.size)
        assertEquals(0, begun)
        // The row held as it was checked is the one written under.
        val made = vault.uploadResult(byteArrayOf(1), "b.txt", null, real.id, null, null, null, onBegun = { begun++ }, held = real)
        assertEquals(server.root, made.node.parentId)
        assertEquals(1, begun)
    }

    /* A family manager's pause answers 403 `held`: the save path reads it as held, never as lost access (DENIED). */
    @Test
    fun aHeldAnswerIsHeldNeverLostAccess() {
        val held = 403 to JSONObject().put("code", "held").put("message", "A group manager has paused changes to this folder.")
        server.extraRoutes = { method, segments, _, _ ->
            when {
                method == "POST" && segments.lastOrNull() == "trash-batch" -> held
                method == "DELETE" && segments.size == 3 && segments[1] == "nodes" -> held
                method == "POST" && segments.lastOrNull() == "abort" -> held
                else -> null
            }
        }
        val writer = VaultSaveWriter(vault) { StorageAllowance(1L shl 40, 0L, 1L shl 40) }
        assertEquals(mapOf("node-x" to SaveItemFate.HELD), writer.trash(listOf("node-x"), vault.workspaceId))
        assertEquals(mapOf("node-x" to SaveItemFate.HELD), writer.purge(listOf("node-x"), vault.workspaceId))
        assertEquals(SaveAbortFate.HELD, vault.api.abortUploadFate("up-x", vault.workspaceId))
        // The reservations ledger keeps it too: nothing ended, asked again after the hold (never taken for gone).
        assertEquals(Reservations.Abort.PENDING, vault.api.abortUpload("up-x", vault.workspaceId))
        // A server before the code says a pause only in words, under `forbidden`: still held.
        assertTrue(ApiError(403, ApiError.LEGACY_HELD, "forbidden").held)
        assertFalse(ApiError(403, "Not allowed.", "forbidden").held)
        server.extraRoutes = null
    }

    /* A folder creation whose answer is lost is sent once more; the 409 for its own id (the first send made it) is the folder. */
    @Test
    fun aFolderCreationSentAgainAfterALostAnswerIsTheFolderTheFirstSendMade() {
        var dropped = false
        server.dropReply = { method, path -> (method == "POST" && path == "drive/folders" && !dropped).also { if (it) dropped = true } }
        val made = vault.createFolder(server.root, "Out")
        assertEquals(2, server.requests.count { it == "POST /api/drive/folders" })
        assertEquals("Out", made.name)
        assertEquals(listOf(made.id), server.children(server.root).filter { it.id == made.id }.map { it.id })
        server.dropReply = null
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

    /*
     * A tool's new version of a file another device renamed while it went up: the name is theirs, as the server serves it,
     * never the one the upload began from (and nothing is signed again). Fails if the old name is kept for the newer record.
     */
    @Test
    fun aToolsNewVersionOfAFileRenamedMeanwhileTakesTheServersName() {
        val id = server.file(server.root, "doc.txt", "first".toByteArray())
        val doc = vault.listChildren(server.root).single { it.id == id }
        var renamed = false
        server.beforeAnswer = { method, path ->
            if (!renamed && method == "PUT" && path.startsWith("/store/")) { renamed = true; server.renameAs(id, "renamed.txt") }
        }
        val landed = vault.uploadResult("mine".toByteArray(), doc.name, null, server.root, doc, doc.node.currentVersion!!.id, copy = null)
        server.beforeAnswer = null
        assertTrue(renamed)
        assertEquals("renamed.txt", landed.name)
        assertEquals("renamed.txt", vault.resolve(id).name)
        assertEquals(server.node(id).metadataVersion.toULong(), landed.node.metadataVersion)
    }

    /* A folder's look asks for no next page after a sign-out: it ends unanswered, never counted from what it saw. */
    @Test
    fun aFolderLookAsksForNoPageAfterASignOut() {
        val epoch = SaveRunJournal.Epoch()
        val writer = VaultSaveWriter(vault, epoch) { throw IllegalStateException("not asked") }
        var pages = 0
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "GET" && segments.lastOrNull() == "children") {
                pages++
                // Signed out while the first page was on its way; one more page follows it.
                epoch.end()
                200 to JSONObject().put("folder", server.node(server.root).json()).put("ancestors", org.json.JSONArray())
                    .put("children", org.json.JSONArray()).put("nextCursor", if (pages == 1) "more" else JSONObject.NULL)
            } else null
        }
        assertThrows(SessionEnded::class.java) { writer.lookFolder(server.root, vault.workspaceId) }
        assertEquals(1, pages)
        server.extraRoutes = null
    }

    /* A sign-out during the first of two trash batches sends no second; a purge or an abort sends nothing after it either. */
    @Test
    fun aSignOutBetweenBatchesOrTriesSendsNothingMore() {
        val epoch = SaveRunJournal.Epoch()
        val writer = VaultSaveWriter(vault, epoch) { throw IllegalStateException("not asked") }
        val ids = List(VaultSaveWriter.MAX_TRASH_BATCH + 1) { "node-$it" }
        server.extraRoutes = { method, segments, _, body ->
            when {
                method == "POST" && segments.lastOrNull() == "trash-batch" -> {
                    epoch.end()
                    val sent = body.getJSONArray("nodeIds")
                    200 to JSONObject().put("results", org.json.JSONArray((0 until sent.length()).map { i ->
                        JSONObject().put("id", sent.getString(i)).put("status", "trashed").put("trashedAt", "now").put("changeSeq", 1)
                    }))
                }
                else -> null
            }
        }
        val fates = writer.trash(ids, vault.workspaceId)
        assertEquals(1, server.requests.count { it.endsWith("/trash-batch") })
        assertEquals(SaveItemFate.DONE, fates["node-0"])
        assertEquals(SaveItemFate.REFUSED, fates[ids.last()])
        // The one more after a lost answer is a send too: none after a sign-out.
        val later = SaveRunJournal.Epoch()
        val again = VaultSaveWriter(vault, later) { throw IllegalStateException("not asked") }
        server.extraRoutes = null
        server.dropReply = { method, path -> (method == "POST" && path.endsWith("/trash-batch")).also { if (it) later.end() } }
        assertThrows(SessionEnded::class.java) { again.trash(listOf("node-y"), vault.workspaceId) }
        assertEquals(2, server.requests.count { it.endsWith("/trash-batch") })
        server.dropReply = null
        // Purge: one request per id, none after the sign-out.
        val purging = SaveRunJournal.Epoch()
        val purger = VaultSaveWriter(vault, purging) { throw IllegalStateException("not asked") }
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "DELETE" && segments.size == 3 && segments[1] == "nodes") { purging.end(); 200 to JSONObject() } else null
        }
        val purged = purger.purge(listOf("node-a", "node-b"), vault.workspaceId)
        assertEquals(1, server.requests.count { it.startsWith("DELETE ") && it.contains("/nodes/node-") })
        assertEquals(SaveItemFate.REFUSED, purged["node-b"])
        // An abort still finishing: no next try after the sign-out.
        val aborting = SaveRunJournal.Epoch()
        val aborter = VaultSaveWriter(vault, aborting) { throw IllegalStateException("not asked") }
        server.extraRoutes = { method, segments, _, _ ->
            if (method == "POST" && segments.lastOrNull() == "abort") {
                aborting.end()
                409 to JSONObject().put("code", "conflict").put("message", "finishing").put("data", JSONObject().put("upload", "completing"))
            } else null
        }
        assertEquals(SaveAbortFate.UNKNOWN, aborter.abortUpload("up", vault.workspaceId, 0L))
        assertEquals(1, server.requests.count { it.contains("/uploads/up/abort") })
        server.extraRoutes = null
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

    /* A new folder's id is heard before its creation is sent; a throw from the hearer sends nothing. */
    @Test
    fun aNewFoldersIdIsHeardBeforeItsCreationIsSent() {
        val existedWhenHeard = ArrayList<Boolean>()
        val made = vault.createFolder(server.root, "Out", onMinted = { id -> existedWhenHeard += server.requests.any { it.startsWith("POST") && it.contains("/folders") } })
        assertEquals(listOf(false), existedWhenHeard)
        assertEquals("Out", server.record(made.id).name)
        val sent = server.requests.count { it.startsWith("POST") && it.contains("/folders") }
        assertThrows(IllegalStateException::class.java) { vault.createFolder(server.root, "Refused", onMinted = { throw IllegalStateException("not recorded") }) }
        assertEquals(sent, server.requests.count { it.startsWith("POST") && it.contains("/folders") })
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

    /* The next free name comes from each row as served now: a child another device renamed is taken by its new name. */
    @Test
    fun theNextFreeNameSeesAChildRenamedElsewhere() {
        val id = server.file(server.root, "report.pdf", "x".toByteArray())
        val root = vault.listChildren(server.root)
        assertTrue(root.any { it.name == "report.pdf" })
        server.renameAs(id, "summary.pdf")
        val folder = vault.nodes.row(server.workspace, server.root) ?: Opened(NodeView(server.root, server.workspace, null, "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null),
            com.hushos.core.NodeMetadata("root", null, null, null, emptyMap()))
        val names = VaultSaveWriter(vault) { throw IllegalStateException("not asked") }.names(folder)
        assertTrue(names.toString(), "summary.pdf" in names)
        assertFalse(names.toString(), "report.pdf" in names)
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
