package com.hushos.app.data

import android.content.Context
import com.hushos.core.Integrity
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.NodeMetadata
import com.hushos.core.PlannedResult
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.deviceRemember
import com.hushos.core.metadataIntegrity
import com.hushos.core.randomBytes
import com.hushos.core.runEstimate
import com.hushos.core.signingPublicKey
import com.hushos.core.versionIntegrity
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

/*
 * The save path on the phone (SaveRuns.kt). A run decides before anything is made whether it may write and whether it
 * fits, saves results from memory under the next free name, ends a version race `stale`, and leaves nothing when it stops.
 * Each test fails on the defect a person would see: a run that starts and fails halfway, a laundered mark, a half-made
 * result left behind, a file an editor may only trash deleted forever, a row the next open needs lost.
 */
class SaveRunTest {
    private fun opened(id: String, parent: String? = "root", version: String? = null, name: String = id): Opened {
        val current = version?.let { VersionView(it, "o", "", "ready", 3u, 1, "n", null, null, null) }
        val node = NodeView(id, "ws", parent, if (version == null) "folder" else "file", 1uL, 1uL, "", 1uL, "", current, null, null, null)
        return Opened(node, NodeMetadata(name, null, null, null, emptyMap()))
    }

    private fun journal() = SaveRunJournal(Files.createTempDirectory("save-runs").resolve(SaveRunJournal.FILE).toFile())

    /* The drive as a run sees it, every call recorded; uploads answer as the test says (land by default). */
    private class FakeWriter(var free: Long? = 1L shl 40) : SaveRunWriter {
        var refusal: String? = null
        var names = listOf<String>()
        var member = true
        var trashFails = false
        val uploads = ArrayList<Triple<String, String?, String?>>()
        val trashed = ArrayList<List<String>>()
        val purged = ArrayList<List<String>>()
        val aborted = ArrayList<String>()
        val answers = ArrayDeque<(Int) -> Unit>()
        private var count = 0

        override fun refusal(target: Opened, copy: Prior?) = refusal
        override fun freeSpace(workspaceId: String) = free
        override fun names(folder: Opened) = names
        override fun makeFolder(folder: Opened, name: String, copy: Prior?): Opened = Opened(
            NodeView("made-$name", "ws", folder.id, "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()),
        )
        override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                                  onBegun: (Vault.BegunIds) -> Unit): Opened {
            val n = ++count
            uploads.add(Triple(name, replacing?.id, startedFrom))
            val nodeId = replacing?.id ?: "node-$n"
            onBegun(Vault.BegunIds("ws", "up-$n", nodeId))
            answers.removeFirstOrNull()?.invoke(n)
            return Opened(NodeView(nodeId, "ws", folder.id, "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(name, null, null, null, emptyMap()))
        }
        override fun abortUpload(uploadId: String, workspaceId: String) { aborted.add(uploadId) }
        override fun trash(ids: List<String>, workspaceId: String) { if (trashFails) throw Unreachable(); trashed.add(ids) }
        override fun purge(ids: List<String>, workspaceId: String) { purged.add(ids) }
        override fun mayPurge(workspaceId: String) = member
    }

    @Test
    fun aReadOnlyFamilyFolderRefusesTheRunBeforeAnythingIsMade() {
        val writer = FakeWriter().apply { refusal = FamilyWords.UNAVAILABLE }
        val rows = journal()
        val refused = assertThrows(SaveRefused::class.java) { SaveRun.start(writer, listOf(opened("fam")), listOf(PlannedResult.Known(1uL)), null, rows) }
        assertEquals(SaveRefused.Reason.READ_ONLY, refused.reason)
        assertTrue(rows.list().isEmpty())
        assertTrue(writer.uploads.isEmpty())
    }

    @Test
    fun aRunThatDoesNotFitIsRefusedByTheCoresEstimateAndOneThatFitsExactlyStarts() {
        val results = listOf(PlannedResult.Known(5_000_000uL), PlannedResult.FromSources(2_000_000uL))
        val needed = runEstimate(results)
        val refused = assertThrows(SaveRefused::class.java) { SaveRun.start(FakeWriter(needed.toLong() - 1), listOf(opened("f")), results, null, journal()) }
        assertEquals(SaveRefused.Reason.NO_ROOM, refused.reason)
        assertEquals(needed, refused.needed)
        assertEquals(needed.toLong() - 1, refused.free)
        val rows = journal()
        val run = SaveRun.start(FakeWriter(needed.toLong()), listOf(opened("f")), results, null, rows)
        assertEquals(listOf(run.id), rows.list().map { it.id })
    }

    @Test
    fun eachResultTakesTheNextFreeNameAndNeverReplaces() {
        val writer = FakeWriter().apply { names = listOf("report.pdf", "Report (2).pdf") }
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), null, journal())
        run.file(byteArrayOf(1), "report.pdf", null)
        run.file(byteArrayOf(1), "REPORT.pdf", null)
        assertEquals(listOf("report (3).pdf", "REPORT (4).pdf"), writer.uploads.map { it.first })
        assertTrue(writer.uploads.all { it.second == null })
    }

    @Test
    fun aVersionSomeoneElseBeatIsStaleAndTheRunGoesOn() {
        val writer = FakeWriter().apply { answers.add { throw SaveStale("v-theirs") } }
        val rows = journal()
        val doc = opened("doc", parent = "f", version = "v1")
        val run = SaveRun.start(writer, listOf(doc), listOf(PlannedResult.Known(1uL)), null, rows)
        assertEquals(VersionSaved.Stale("v-theirs"), run.version(byteArrayOf(1), doc, opened("f"), "v1"))
        assertEquals("v1", writer.uploads.single().third)
        // The file is never the run's to delete, and the run is not stopped.
        assertEquals(emptyList<String>(), rows.list().single().nodeIds)
        run.file(byteArrayOf(2), "after.txt", null)
        run.finish()
        assertTrue(writer.trashed.isEmpty())
        assertTrue(rows.list().isEmpty())
    }

    @Test
    fun aCancelDeletesForeverWhatWasPublishedAndTheRowGoes() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), null, rows)
        run.file(byteArrayOf(1), "a", null)
        assertEquals(listOf("node-1"), rows.list().single().nodeIds)
        assertEquals(SaveCleanup.DELETED, run.cancel())
        assertEquals(listOf(listOf("node-1")), writer.trashed)
        assertEquals(listOf(listOf("node-1")), writer.purged)
        assertTrue(rows.list().isEmpty())
        assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "b", null) }
    }

    @Test
    fun aNoRoomInSomeoneElsesShareStopsTheRunUnfiguredAndOnlyTrashes() {
        val writer = FakeWriter(free = null).apply {
            member = false
            answers.add { }
            answers.add { throw ApiError(402, "There isn’t enough room. 12 MB free.") }
        }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("shared")), listOf(PlannedResult.Known(1uL shl 50)), null, rows)
        run.file(byteArrayOf(1), "a", null)
        val stopped = assertThrows(SaveRunStopped::class.java) { run.file(byteArrayOf(1), "b", null) }
        assertEquals(SaveRunStopped.Reason.NO_ROOM, stopped.reason)
        // The owner's free space the server named is never passed on.
        assertEquals(SaveRuns.NO_ROOM_SHARED, stopped.message)
        assertEquals(SaveCleanup.TRASHED, stopped.cleanup)
        assertEquals(listOf(listOf("node-1", "node-2")), writer.trashed)
        assertTrue(writer.purged.isEmpty())
        assertEquals(listOf("up-2"), writer.aborted)
        assertTrue(rows.list().isEmpty())
    }

    @Test
    fun aFolderTheRunMadeGoesAsOne() {
        val writer = FakeWriter()
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), null, rows)
        val made = run.folder("Archive")
        run.file(byteArrayOf(1), "inside.txt", null, made)
        assertEquals(listOf(made.id), rows.list().single().nodeIds)
        run.cancel()
        assertEquals(listOf(listOf(made.id)), writer.trashed)
    }

    @Test
    fun aKeyChangeStillWalkingTheFolderIsWaitedOutNotFailed() {
        val writer = FakeWriter().apply { answers.add { throw ApiError(409, "Finishing a key change…", "rotating") } }
        var pauses = 0
        val run = SaveRun.start(writer, listOf(opened("fam")), emptyList(), null, journal(), pause = { pauses++ })
        assertEquals("node-2", run.file(byteArrayOf(1), "a", null).id)
        assertEquals(1, pauses)
        assertEquals(2, writer.uploads.size)
    }

    @Test
    fun aCleanUpThatCannotReachTheServerKeepsTheRowAndTheNextLaunchFindsIt() {
        val writer = FakeWriter().apply { trashFails = true }
        val rows = journal()
        val run = SaveRun.start(writer, listOf(opened("f")), emptyList(), null, rows)
        run.file(byteArrayOf(1), "a", null)
        assertEquals(SaveCleanup.LEFT, run.cancel())
        assertEquals(listOf(listOf("node-1")), rows.list().map { it.nodeIds })
        // This launch's own row is not interrupted; another launch's is.
        assertTrue(SaveRuns.interrupted(rows).isEmpty())
        val other = SaveRunRow("other", "ws", listOf("node-x"), listOf("up-x"), 1L, "an-earlier-launch")
        rows.put(other)
        assertEquals(listOf("other"), SaveRuns.interrupted(rows).map { it.id })
        writer.trashFails = false
        assertEquals(SaveCleanup.DELETED, SaveRuns.cleanUp(other, writer, rows))
        assertEquals(listOf("up-x"), writer.aborted)
        assertEquals(listOf("node-x"), writer.purged.last())
        assertFalse(rows.list().any { it.id == "other" })
    }

    /*
     * Real statements: a result of a verified source and an unverified one, signed as SaveRuns.signing says and read back
     * under this person's key, is re-sealed (Unverified), never verified; with a link's, saved from a link.
     */
    @Test
    fun aResultOfSeveralSourcesReadsAsItsWeakestSource() {
        val seed = randomBytes(32u)
        val mine = TrustedKeys(signingPublicKey(seed), emptyList())
        val ws = "600e9d40-c3b4-49bd-8e63-9bd7b3f63dbc"
        val statement = MetadataStatement(ws, "dc94437c-d237-4f94-bef8-9caeb51bea5e", NodeKind.FILE, 1uL)
        val versionStatement = VersionStatement(ws, statement.nodeId, "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d", "471517d1-c35e-4f99-83b9-067be718ecb1", 3u)
        val envelope = randomBytes(64u)
        val keyEnvelope = randomBytes(84u)
        fun readBack(prior: Prior) = metadataIntegrity(mine, statement, envelope, copyMetadataSignature(seed, statement, envelope, prior)) to
            versionIntegrity(mine, versionStatement, keyEnvelope, copyVersionSignature(seed, versionStatement, keyEnvelope, prior))
        val verified = Prior(Integrity.VERIFIED, Integrity.VERIFIED)
        val planted = Prior(Integrity.VERIFIED, Integrity.UNKNOWN_SIGNER)
        assertEquals(Integrity.VERIFIED to Integrity.VERIFIED, readBack(SaveRuns.signing(listOf(verified, verified))))
        assertEquals(Integrity.VERIFIED to Integrity.RESEALED, readBack(SaveRuns.signing(listOf(verified, planted))))
        assertEquals(Integrity.SAVED_FROM_LINK to Integrity.SAVED_FROM_LINK, readBack(SaveRuns.signing(listOf(verified, Prior.FROM_LINK))))
        assertThrows(Exception::class.java) { SaveRuns.signing(emptyList()) }
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

    /* Fails if the result is staged in a file on its way (plaintext on disk), or what lands is not the bytes given. */
    @Test
    fun aResultUploadsFromMemoryAndLandsAsItsBytes() {
        val bytes = "tool output ${UUID.randomUUID()}, never on disk".toByteArray()
        val landed = vault.uploadResult(bytes, "out.txt", "text/plain", server.root, null, null, copy = null)
        assertEquals(emptyList<File>(), holding(bytes))
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
        val theirs = server.node(id).version?.id
        assertEquals(theirs, raced.currentVersionId)
        assertTrue(theirs != startedFrom)
        assertTrue(server.requests.any { it.contains("/abort") })
    }
}
