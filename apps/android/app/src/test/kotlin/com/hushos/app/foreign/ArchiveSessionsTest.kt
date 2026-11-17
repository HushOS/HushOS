package com.hushos.app.foreign

import com.hushos.app.data.ArchiveSessions
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
        val plain = File(fixtures, "basic.zip").readBytes()
        val (content, stored) = sealed(plain)
        val hold = CountDownLatch(1)
        val waiting = CountDownLatch(1)
        val holding = java.util.concurrent.atomic.AtomicBoolean(false)
        val archive = ArchiveSessions().open(store(stored) {
            if (holding.get()) { waiting.countDown(); hold.await(10, TimeUnit.SECONDS) }
        }, content)
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
