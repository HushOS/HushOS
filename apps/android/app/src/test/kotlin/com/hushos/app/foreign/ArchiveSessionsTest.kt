package com.hushos.app.foreign

import com.hushos.app.data.ArchiveSessions
import com.hushos.app.data.FamilyFailure
import com.hushos.app.data.StoreSource
import com.hushos.core.ArchiveException
import com.hushos.core.Content
import com.hushos.core.EntrySink
import com.hushos.core.chunkEncrypt
import com.hushos.core.chunkLength
import com.hushos.core.contentLayout
import com.hushos.core.randomBytes
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import kotlin.coroutines.cancellation.CancellationException

/*
 * A zip open in the app, through the core's session over a sealed object served chunk by chunk:
 * the password refused, then kept, then wiped by a sign-out's closeAll; a call that hangs on the
 * store ended by its coroutine's cancel, the next call waiting for its thread to return;
 * and a download held to the entry's bytes. The fixture is e2e/fixtures/archives/aes.zip, the one
 * the web and the core are held to.
 */
class ArchiveSessionsTest {
    @get:Rule
    val timeout = DumpOnTimeout(60)

    private val fixtures = File(System.getProperty("user.dir"), "../../../e2e/fixtures/archives")

    private fun sealed(plain: ByteArray): Pair<Content, ByteArray> {
        val size = plain.size.toLong()
        val content = Content("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", 3u,
            randomBytes(32u), randomBytes(16u), size.toULong(), 0u)
        val layout = contentLayout(3u, size.toULong(), 0u)
        val stored = java.io.ByteArrayOutputStream()
        val chunk = 8L * 1024 * 1024
        for (index in 0uL until layout.chunkCount) {
            val start = minOf(index.toLong() * chunk, size).toInt()
            val length = chunkLength(size.toULong(), index).toInt()
            stored.write(chunkEncrypt(content, index, plain.copyOfRange(start, start + length)))
        }
        return content to stored.toByteArray()
    }

    private fun store(stored: ByteArray, gate: () -> Unit = {}) = StoreSource { range, _ ->
        gate()
        stored.copyOfRange(range.start.toInt(), range.end.toInt() + 1)
    }

    @Test fun aPasswordIsKeptOnlyOnceItOpensAndASignOutWipesIt() = runBlocking {
        val sessions = ArchiveSessions()
        val (content, stored) = sealed(File(fixtures, "aes.zip").readBytes())
        val archive = sessions.open(store(stored), content)
        assertEquals(listOf("secret.txt", "secret-ae1.txt", "plain.txt"), archive.entries.map { it.path })
        assertEquals("aes", archive.entries[0].lock)
        assertFalse(archive.unlock("not it"))
        try {
            archive.preview(0u, 1024)
            fail("previewed without the password")
        } catch (error: ArchiveException.Refused) {
            assertEquals("password", error.code)
        }
        assertTrue(archive.unlock("correct horse battery"))
        assertTrue(archive.preview(0u, 1024).decodeToString().contains("HUSHOS-CANARY-ZIP-5b1e9c"))
        assertEquals(1, sessions.count)
        sessions.closeAll()
        assertEquals(0, sessions.count)
        assertFalse(archive.unlocked)
        try {
            archive.preview(0u, 1024)
            fail("read after the sign-out")
        } catch (_: CancellationException) {
        }
    }

    @Test fun aKeptCopyOpensFromThePhoneWithoutTheStore() = runBlocking {
        val plain = File(fixtures, "aes.zip").readBytes()
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val kept = object : com.hushos.core.LocalSource {
            override fun size() = plain.size.toULong()
            override fun readAt(offset: ULong, length: ULong): ByteArray {
                reads.incrementAndGet()
                return plain.copyOfRange(offset.toInt(), (offset + length).toInt())
            }
        }
        val archive = ArchiveSessions().openLocal(kept)
        assertTrue(reads.get() > 0)
        assertFalse(archive.unlock("not it"))
        // Tried on its own item first, as when that item asked for its password.
        assertTrue(archive.unlock("correct horse battery", 1u))
        assertTrue(archive.preview(1u, 1024).decodeToString().contains("AE-1"))
        archive.close()
        try {
            archive.preview(2u, 1024)
            fail("read after close")
        } catch (_: CancellationException) {
        }
    }

    @Test fun aPasswordOnlyItsCheckBytePassedIsLetGoOfWhenItsItemReadsAsDamaged() = runBlocking {
        // unproven.zip: "wrong 516" passes the one ZipCrypto check byte of an item an unlock can't inflate.
        val (content, stored) = sealed(File(fixtures, "unproven.zip").readBytes())
        val sessions = ArchiveSessions()
        val archive = sessions.open(store(stored), content)
        assertTrue(archive.unlock("wrong 516"))
        val sibling = archive.sibling()
        try {
            sibling.download(0u, object : EntrySink { override fun write(chunk: ByteArray) {} })
            fail("downloaded under a wrong password")
        } catch (error: ArchiveException.Refused) {
            assertEquals("password-unproven", error.code)
        }
        // Let go of on the archive too, not only the download's sibling: every item asks again.
        assertFalse(archive.unlocked)
        sessions.closeAll()
    }

    @Test fun aStoppedDownloadKeepsAPasswordOnlyItsCheckBytePassed() = runBlocking {
        // unproven.zip under the right password, which only its check byte proves: a stop is no damage.
        val (content, stored) = sealed(File(fixtures, "unproven.zip").readBytes())
        val sessions = ArchiveSessions()
        val archive = sessions.open(store(stored), content)
        assertTrue(archive.unlock("correct horse battery", 0u))
        val wrote = CountDownLatch(1)
        val stopped = async(kotlinx.coroutines.Dispatchers.IO) {
            archive.sibling().download(0u, object : EntrySink {
                override fun write(chunk: ByteArray) {
                    wrote.countDown()
                    Thread.sleep(300)
                }
            })
        }
        assertTrue(wrote.await(30, TimeUnit.SECONDS))
        stopped.cancel()
        try {
            stopped.await()
            fail("a stopped download finished")
        } catch (_: CancellationException) {
        }
        assertTrue(archive.unlocked)
        // A sink that fails is the download's own end too.
        try {
            archive.sibling().download(0u, object : EntrySink { override fun write(chunk: ByteArray) = throw com.hushos.core.FetchException.Failed("No space left.") })
            fail("wrote into a failing sink")
        } catch (error: Exception) {
            assertFalse(error is ArchiveException.Refused && error.code == "password-unproven")
        }
        assertTrue(archive.unlocked)
        var size = 0L
        archive.sibling().download(0u, object : EntrySink { override fun write(chunk: ByteArray) { size += chunk.size } })
        assertEquals(2L shl 20, size)
        sessions.closeAll()
    }

    @Test fun aStoreRefusalOfTheSessionIsSaidAsItselfWithItsSession() = runBlocking {
        // The API answers 401 for the version's address: the session ended under the archive's reads.
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.sendResponseHeaders(401, -1)
            exchange.close()
        }
        server.start()
        try {
            val (content, _) = sealed(File(fixtures, "basic.zip").readBytes())
            val session = com.hushos.app.data.Shared.Session("http://127.0.0.1:${server.address.port}", "token", "user")
            val current = com.hushos.app.data.CallControl()
            val source = com.hushos.app.data.archiveSourceOf(com.hushos.app.data.DriveApi(session), "version", "workspace", current)
            try {
                ArchiveSessions().open(source, content, current, signedIn = session)
                fail("opened without the store")
            } catch (error: com.hushos.app.data.ArchiveSessionRefused) {
                // Not the core's failure in words: the 401, with the session it was read under, for the app's session check.
                assertEquals(session, error.session)
            }
        } finally {
            server.stop(0)
        }
        // Any other failure of the store is still the archive's own.
        val (content, _) = sealed(File(fixtures, "basic.zip").readBytes())
        try {
            ArchiveSessions().open(StoreSource { _, _ -> throw java.io.IOException("Down") }, content)
            fail("opened without the store")
        } catch (error: Exception) {
            assertFalse(error is com.hushos.app.data.ArchiveSessionRefused)
        }
    }

    @Test fun aSessionMadeAsItsOpenIsCancelledIsClosedNotLeftWithItsKey() = runBlocking {
        val (content, stored) = sealed(File(fixtures, "aes.zip").readBytes())
        val sessions = ArchiveSessions()
        val made = CountDownLatch(1)
        val release = CountDownLatch(1)
        val produced = java.util.concurrent.atomic.AtomicReference<com.hushos.core.ZipArchiveSession?>()
        // Held on the call's thread once the core has made the session, before the caller hears of it.
        sessions.made = { session ->
            produced.set(session)
            made.countDown()
            release.await(30, TimeUnit.SECONDS)
        }
        val opening = async(kotlinx.coroutines.Dispatchers.IO) { sessions.open(store(stored), content) }
        assertTrue(made.await(30, TimeUnit.SECONDS))
        // Exactly then, Back (or a sign-out) cancels the open.
        opening.cancel()
        try {
            opening.await()
            fail("opened after a cancel")
        } catch (_: CancellationException) {
        }
        release.countDown()
        // The session the caller never heard of is closed: its listing and its key are gone.
        val session = produced.get()!!
        assertTrue(session.entries().isEmpty())
        assertFalse(session.unlocked())
        sessions.closeAll()
    }

    @Test fun aFamilyLetGoOfClosesItsArchiveAndWritesNothingMore() = runBlocking {
        // A family's file: its folder let go of (a removal, a fork) while a download streams it.
        val words = java.util.concurrent.atomic.AtomicReference<String?>(null)
        val zip = java.io.ByteArrayOutputStream().also { bytes ->
            java.util.zip.ZipOutputStream(bytes).use { out ->
                out.putNextEntry(java.util.zip.ZipEntry("big.bin"))
                out.write(ByteArray(3 shl 20).also(java.util.Random(7)::nextBytes))
                out.closeEntry()
            }
        }.toByteArray()
        val (content, stored) = sealed(zip)
        val sessions = ArchiveSessions()
        val archive = sessions.open(store(stored), content, stands = { words.get() })
        val sibling = archive.sibling()
        val pieces = java.util.concurrent.atomic.AtomicInteger()
        try {
            sibling.download(0u, object : EntrySink {
                override fun write(chunk: ByteArray) {
                    pieces.incrementAndGet()
                    words.set("This family folder was removed.")
                }
            })
            fail("downloaded on after the family went")
        } catch (error: FamilyFailure) {
            assertEquals("This family folder was removed.", error.message)
        }
        // The first piece only, and the sibling closed with its call.
        assertEquals(1, pieces.get())
        assertTrue(sibling.closed)
        // The archive goes at its next call, before anything is read.
        try {
            archive.preview(0u, 1024)
            fail("previewed after the family went")
        } catch (_: FamilyFailure) {
        }
        assertTrue(archive.closed)
        assertEquals(0, sessions.count)
    }

    @Test fun aSiblingDownloadsALockedItemWithTheParentsPasswordWhileTheParentPreviews() = runBlocking {
        val (content, stored) = sealed(File(fixtures, "aes.zip").readBytes())
        val sessions = ArchiveSessions()
        val archive = sessions.open(store(stored), content)
        assertTrue(archive.unlock("correct horse battery"))
        val sibling = archive.sibling()
        // The sibling's download holds in its sink until the parent's preview has finished.
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val out = java.io.ByteArrayOutputStream()
        val download = async(kotlinx.coroutines.Dispatchers.Default) {
            sibling.download(1u, object : EntrySink {
                override fun write(chunk: ByteArray) {
                    entered.countDown()
                    assertTrue(release.await(10, TimeUnit.SECONDS))
                    out.write(chunk)
                }
            })
        }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        // Previewing on the parent goes ahead while the sibling's call is still running.
        assertTrue(archive.preview(0u, 1024).decodeToString().contains("AES-256, AE-2."))
        assertEquals(1, sibling.live)
        release.countDown()
        download.await()
        assertTrue(out.toString(Charsets.UTF_8).contains("AES-256, AE-1."))
        // A sign-out reaches the sibling too.
        assertEquals(2, sessions.count)
        sessions.closeAll()
        assertEquals(0, sessions.count)
        try {
            sibling.preview(1u, 1024)
            fail("read on a sibling after the sign-out")
        } catch (_: CancellationException) {
        }
    }

    @Test fun aKeptCopyThatCantBeReadSaysSo() = runBlocking {
        val kept = object : com.hushos.core.LocalSource {
            override fun size() = 4096uL
            override fun readAt(offset: ULong, length: ULong): ByteArray = throw com.hushos.core.FetchException.Failed("The kept copy couldn't be read.")
        }
        try {
            ArchiveSessions().openLocal(kept)
            fail("opened an unreadable copy")
        } catch (error: ArchiveException.Failed) {
            assertEquals("The kept copy couldn't be read.", error.reason)
        }
    }

    @Test fun aDownloadStreamsTheEntryAndNothingMore() = runBlocking {
        val (content, stored) = sealed(File(fixtures, "basic.zip").readBytes())
        val archive = ArchiveSessions().open(store(stored), content)
        val readme = archive.entries.indexOfFirst { it.path == "docs/readme.txt" }.toUInt()
        val out = java.io.ByteArrayOutputStream()
        archive.download(readme, object : EntrySink {
            override fun write(chunk: ByteArray) = out.write(chunk)
        })
        assertEquals("Read me. This entry is deflated.\nHUSHOS-CANARY-ZIP-5b1e9c\n", out.toString(Charsets.UTF_8))
        archive.close()
    }

    @Test fun aCancelledCallEndsAtOnceAndTheNextWaitsForItsThread() = runBlocking {
        // Over a kept copy, which reads every range afresh (a version's reader keeps the chunks it
        // read for the session, so a small archive would never reach the store again).
        val plain = File(fixtures, "basic.zip").readBytes()
        val hold = CountDownLatch(1)
        val waiting = CountDownLatch(1)
        val holding = java.util.concurrent.atomic.AtomicBoolean(false)
        val archive = ArchiveSessions().openLocal(object : com.hushos.core.LocalSource {
            override fun size() = plain.size.toULong()
            override fun readAt(offset: ULong, length: ULong): ByteArray {
                if (holding.get()) { waiting.countDown(); hold.await(10, TimeUnit.SECONDS) }
                return plain.copyOfRange(offset.toInt(), (offset + length).toInt())
            }
        })
        holding.set(true)
        val readme = archive.entries.indexOfFirst { it.path == "docs/readme.txt" }.toUInt()
        val first = async(kotlinx.coroutines.Dispatchers.Default) { runCatching { archive.preview(readme, 1024) } }
        assertTrue(waiting.await(10, TimeUnit.SECONDS))
        first.cancel()
        first.join()
        // The thread is still in the store's hands: the next call starts only after it returns.
        assertEquals(1, archive.live)
        holding.set(false)
        val second = async(kotlinx.coroutines.Dispatchers.Default) { archive.preview(readme, 1024) }
        hold.countDown()
        assertTrue(second.await().decodeToString().startsWith("Read me."))
        assertEquals(0, archive.live)
        archive.close()
    }
}
