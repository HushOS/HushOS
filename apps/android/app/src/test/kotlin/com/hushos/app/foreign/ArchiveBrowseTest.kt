package com.hushos.app.foreign

import com.hushos.app.data.ArchiveSessions
import com.hushos.app.data.OpenArchive
import com.hushos.app.ui.ArchiveBrowse
import com.hushos.app.ui.ArchiveSubject
import com.hushos.app.ui.EntryDownload
import com.hushos.core.ArchiveException
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The archive the view model holds (ArchiveBrowse), over a kept copy of a fixture: a session opened
 * but never handed over is closed, and a download its password refused goes back to the item.
 */
class ArchiveBrowseTest {
    private val fixtures = File(System.getProperty("user.dir"), "../../../e2e/fixtures/archives")

    private fun kept(name: String) = File(fixtures, name).readBytes().let { plain ->
        object : com.hushos.core.LocalSource {
            override fun size() = plain.size.toULong()
            override fun readAt(offset: ULong, length: ULong) = plain.copyOfRange(offset.toInt(), (offset + length).toInt())
        }
    }

    @Test fun anArchiveClosedWhileItsTreeIsBuildingClosesTheSessionItOpened() = runBlocking {
        val sessions = ArchiveSessions()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val opened = CompletableDeferred<OpenArchive>()
        val building = CompletableDeferred<Unit>()
        val browse = ArchiveBrowse(
            ArchiveSubject("a", "basic.zip"),
            scope,
            open = { sessions.openLocal(kept("basic.zip")).also { opened.complete(it) } },
            build = { _, _ -> building.complete(Unit); awaitCancellation() },
        )
        withTimeout(10_000) { building.await() }
        // Back while the tree builds: the archive isn't handed over yet, and its session must not outlive it.
        browse.close()
        val session = opened.await()
        withTimeout(10_000) { while (sessions.count > 0) kotlinx.coroutines.delay(20) }
        assertTrue(session.closed)
        assertNull(browse.archive)
        scope.cancel()
    }

    @Test fun anArchiveWhoseFamilyGoesWhileItsTreeBuildsIsNeverShown() = runBlocking {
        val sessions = ArchiveSessions()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val workspace = "11111111-1111-4111-8111-111111111111"
        val words = java.util.concurrent.atomic.AtomicReference<String?>(null)
        val opened = CompletableDeferred<OpenArchive>()
        val browse = ArchiveBrowse(
            ArchiveSubject("a", "basic.zip"),
            scope,
            open = { sessions.openLocal(kept("basic.zip"), stands = { words.get() }, workspace = workspace).also { opened.complete(it) } },
            // While the tree builds, the family is let go of (or the share's workspace proven a family's): closed then.
            build = { entries, folders ->
                words.set("Open the family again, then try again.")
                sessions.closeWorkspaces(listOf(workspace))
                com.hushos.app.data.ArchiveTree(entries, folders)
            },
        )
        withTimeout(10_000) { while (browse.failure == null && browse.tree == null) kotlinx.coroutines.delay(20) }
        // Never shown: no tree, no archive, the family's words, and the session closed.
        assertNull(browse.tree)
        assertNull(browse.archive)
        assertEquals("Open the family again, then try again.", browse.failure)
        assertTrue(opened.await().closed)
        browse.close()
        scope.cancel()
    }

    @Test fun aShownArchiveWhoseWorkspaceIsProvenAFamilysLeavesTheScreen() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val sessions = ArchiveSessions()
        val workspace = "22222222-2222-4222-8222-222222222222"
        val browse = ArchiveBrowse(ArchiveSubject("a", "basic.zip"), scope, open = { sessions.openLocal(kept("basic.zip"), workspace = workspace) })
        withTimeout(10_000) { while (browse.tree == null) kotlinx.coroutines.delay(20) }
        val shown = browse.archive!!
        browse.opened = shown.entries.first { it.path == "docs/readme.txt" }
        // The proof (noteFamilyWorkspaces) closes it: the list and the item shown leave the screen, the family's words stay.
        sessions.closeWorkspaces(listOf(workspace))
        withTimeout(10_000) { while (browse.tree != null) kotlinx.coroutines.delay(20) }
        assertNull(browse.archive)
        assertNull(browse.opened)
        assertEquals("Open the family again, then try again.", browse.failure)
        assertTrue(shown.closed)
        browse.close()
        // A kept copy whose record predates its workspace's: found by the node the purge named.
        val kept = ArchiveBrowse(ArchiveSubject("k", "basic.zip"), scope, open = { sessions.openLocal(kept("basic.zip"), node = "node-kept") })
        withTimeout(10_000) { while (kept.tree == null) kotlinx.coroutines.delay(20) }
        sessions.closeWorkspaces(emptyList(), nodes = listOf("node-kept"))
        withTimeout(10_000) { while (kept.tree != null) kotlinx.coroutines.delay(20) }
        assertNull(kept.archive)
        kept.close()
        scope.cancel()
    }

    /* The Save dialog's document as a file: made empty, or one already there that the person chose to replace. */
    private class FileDestination(val file: File, private val known: Boolean = true) : com.hushos.app.ui.SaveDestination {
        @Volatile var deleted = false
        val hold = java.util.concurrent.CountDownLatch(1)
        val writing = java.util.concurrent.CountDownLatch(1)
        override fun size(): Long? = if (known && file.exists()) file.length() else null
        override fun open(): java.io.OutputStream = object : java.io.FileOutputStream(file, false) {
            // Both: FileOutputStream's write(ByteArray) doesn't go through write(ByteArray, Int, Int).
            override fun write(b: ByteArray) = write(b, 0, b.size)
            override fun write(b: ByteArray, off: Int, len: Int) {
                super.write(b, off, len)
                writing.countDown()
                hold.await(30, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        override fun delete() {
            deleted = true
            file.delete()
        }
    }

    /* A zip of one 3 MiB stored entry: three pieces of a MiB each. */
    private fun big(): com.hushos.core.LocalSource {
        val bytes = java.io.ByteArrayOutputStream().also { out ->
            java.util.zip.ZipOutputStream(out).use { zip ->
                val data = ByteArray(3 shl 20) { (it * 31).toByte() }
                val crc = java.util.zip.CRC32().apply { update(data) }
                zip.putNextEntry(java.util.zip.ZipEntry("big.bin").apply { method = java.util.zip.ZipEntry.STORED; size = data.size.toLong(); compressedSize = data.size.toLong(); this.crc = crc.value })
                zip.write(data)
                zip.closeEntry()
            }
        }.toByteArray()
        return object : com.hushos.core.LocalSource {
            override fun size() = bytes.size.toULong()
            override fun readAt(offset: ULong, length: ULong) = bytes.copyOfRange(offset.toInt(), (offset + length).toInt())
        }
    }

    @Test fun aDownloadStoppedMidStreamLeavesNoFileBehind() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val browse = ArchiveBrowse(ArchiveSubject("b", "big.zip"), scope, open = { ArchiveSessions().openLocal(big()) })
        withTimeout(10_000) { while (browse.tree == null) kotlinx.coroutines.delay(20) }
        val entry = browse.archive!!.entries.single()
        // The Save dialog made it: empty.
        val made = FileDestination(File.createTempFile("save", ".bin"))
        browse.startDownload(entry, made) {}
        assertTrue(made.writing.await(30, java.util.concurrent.TimeUnit.SECONDS))
        // Stopped while the first piece is being written.
        browse.stop(browse.downloads.single())
        made.hold.countDown()
        withTimeout(10_000) { while (!made.deleted) kotlinx.coroutines.delay(20) }
        kotlinx.coroutines.delay(300)
        // Gone, and nothing written to it after the stop (the call thread may still be running).
        assertFalse(made.file.exists())
        browse.close()
        scope.cancel()
    }

    @Test fun aReplacedFileStaysWhenNothingWasWrittenAndGoesWhenAPartWas() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val browse = ArchiveBrowse(ArchiveSubject("a", "aes.zip"), scope, open = { ArchiveSessions().openLocal(kept("aes.zip")) })
        withTimeout(10_000) { while (browse.tree == null) kotlinx.coroutines.delay(20) }
        val locked = browse.archive!!.entries.first { it.lock != "none" }
        // A file the person chose to replace, and a download refused before any piece (no password held).
        val theirs = FileDestination(File.createTempFile("save", ".txt").apply { writeText("their own") }).apply { hold.countDown() }
        browse.startDownload(locked, theirs) {}
        withTimeout(10_000) { while (browse.downloads.isNotEmpty()) kotlinx.coroutines.delay(20) }
        assertFalse(theirs.deleted)
        assertEquals("their own", theirs.file.readText())
        // A provider that doesn't say a size: unknown is never taken as made, so nothing is deleted.
        val unknown = FileDestination(File.createTempFile("save", ".txt").apply { writeText("unknown") }, known = false).apply { hold.countDown() }
        browse.discardIfMade(unknown)
        assertFalse(unknown.deleted)
        browse.close()
        // A replaced file that a part was written to, then the download stopped: gone, never a part under its name.
        val bigBrowse = ArchiveBrowse(ArchiveSubject("b", "big.zip"), scope, open = { ArchiveSessions().openLocal(big()) })
        withTimeout(10_000) { while (bigBrowse.tree == null) kotlinx.coroutines.delay(20) }
        val replaced = FileDestination(File.createTempFile("save", ".bin").apply { writeText("older and longer") })
        bigBrowse.startDownload(bigBrowse.archive!!.entries.single(), replaced) {}
        assertTrue(replaced.writing.await(30, java.util.concurrent.TimeUnit.SECONDS))
        bigBrowse.stop(bigBrowse.downloads.single())
        replaced.hold.countDown()
        withTimeout(10_000) { while (!replaced.deleted) kotlinx.coroutines.delay(20) }
        assertFalse(replaced.file.exists())
        bigBrowse.close()
        scope.cancel()
    }

    @Test fun aDownloadRefusedForItsPasswordOpensTheItemToAskForIt() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val browse = ArchiveBrowse(ArchiveSubject("a", "aes.zip"), scope, open = { ArchiveSessions().openLocal(kept("aes.zip")) })
        withTimeout(10_000) { while (browse.tree == null) kotlinx.coroutines.delay(20) }
        val entry = browse.archive!!.entries.first { it.lock != "none" }
        val record = EntryDownload(entry)
        browse.downloads.add(record)
        browse.downloadFailed(record, ArchiveException.Refused("wrong-password"))
        // Not a dead end on the download's bar: the item is open, asking for its own password.
        assertEquals(entry, browse.opened)
        assertTrue(entry.index in browse.reprompt)
        assertTrue(browse.downloads.isEmpty())
        // Anything else stays on the bar, in the item's words: a damaged item in the one sentence every client says.
        val other = EntryDownload(entry)
        browse.downloads.add(other)
        browse.downloadFailed(other, ArchiveException.Refused("crc"))
        assertEquals("This item is damaged, or isn’t something HushOS can read.", other.error.value)
        browse.close()
        scope.cancel()
    }

    @Test fun aDownloadThatAskedForAPasswordGoesOnOnceItUnlocksAndAPreviewDoesNot() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val browse = ArchiveBrowse(ArchiveSubject("a", "aes.zip"), scope, open = { ArchiveSessions().openLocal(kept("aes.zip")) })
        withTimeout(10_000) { while (browse.tree == null) kotlinx.coroutines.delay(20) }
        val (secret, other) = browse.archive!!.entries.filter { it.lock != "none" }.take(2)
        // Download on a locked item: its pane opens on the password, and the download waits on it.
        browse.downloadOnceUnlocked(secret)
        assertEquals(secret, browse.opened)
        assertEquals(secret.index, browse.downloadAfterPassword)
        // Unlocked: the download goes on, once.
        assertTrue(browse.unlockedFor(secret))
        assertTrue(browse.unlocked)
        assertEquals(null, browse.downloadAfterPassword)
        assertFalse(browse.unlockedFor(secret))
        // Opened to look at it, an item's password opens a preview, never a download.
        browse.passwordLost(doubt = false)
        browse.show(secret)
        assertFalse(browse.unlockedFor(secret))
        // A download waiting on one item is let go of when another is opened to look at.
        browse.downloadOnceUnlocked(secret)
        browse.show(other)
        assertFalse(browse.unlockedFor(secret))
        // A download refused for the password held goes back to the item, and goes on once it unlocks.
        val record = EntryDownload(other)
        browse.downloads.add(record)
        browse.downloadFailed(record, ArchiveException.Refused("password-unproven"))
        assertEquals(other, browse.opened)
        assertTrue(browse.unlockedFor(other))
        browse.close()
        scope.cancel()
    }
}
