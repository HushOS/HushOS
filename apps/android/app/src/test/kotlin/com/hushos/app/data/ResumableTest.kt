package com.hushos.app.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

/* What a flaky connection does to a transfer: retries, waits, and picking up where it stopped. */
class ResumableTest {
    private val chunk = 4L
    private val plain = ByteArray(10) { it.toByte() } // chunks 0..3, 4..7, 8..9
    private fun piece(index: ULong) = plain.copyOfRange((index.toLong() * chunk).toInt(), minOf(plain.size, ((index.toLong() + 1) * chunk).toInt()))
    private fun dir(): File = Files.createTempDirectory("resumable").toFile()

    @Test
    fun `a chunk the network dropped is fetched again and the file comes out whole`() {
        val out = File(dir(), "f.bin")
        var failures = 1
        val waits = ArrayList<Long>()
        Resumable.download(out, 3uL, chunk, sleep = { waits.add(it) }) { index ->
            if (index == 1uL && failures-- > 0) throw Unreachable()
            piece(index)
        }
        assertArrayEquals(plain, out.readBytes())
        assertEquals(1, waits.size)
        assertFalse(File(out.path + ".part").exists())
    }

    @Test
    fun `a part file from an earlier try is continued from its last whole chunk`() {
        val out = File(dir(), "f.bin")
        // Chunk 0 whole, chunk 1 cut short with a wrong byte: only chunk 0 may be kept.
        File(out.path + ".part").writeBytes(piece(0uL) + byteArrayOf(99))
        val fetched = ArrayList<ULong>()
        Resumable.download(out, 3uL, chunk, sleep = {}) { index -> fetched.add(index); piece(index) }
        assertEquals(listOf(1uL, 2uL), fetched)
        assertArrayEquals(plain, out.readBytes())
    }

    @Test
    fun `offline time does not count as failed tries, and a refusal fails at once`() {
        var online = false
        var calls = 0
        val result = Resumable.run(online = { online }, sleep = { calls++; if (calls == 20) online = true }) {
            if (calls < 20) throw Unreachable()
            "ok"
        }
        assertEquals("ok", result) // twenty failures while offline, more than MAX_ATTEMPTS, and still it finished
        var tries = 0
        assertThrows(ApiError::class.java) { Resumable.run(sleep = {}) { tries++; throw ApiError(404, "gone") } }
        assertEquals(1, tries)
    }

    @Test
    fun `an expired address is refreshed before the next try`() {
        var refreshed = 0
        var first = true
        Resumable.run(sleep = {}, onExpired = { refreshed++ }) { if (first) { first = false; throw ApiError(403, "expired") }; "ok" }
        assertEquals(1, refreshed)
    }
}

/*
 * A suite 3 object is padded: a 10-byte file in 4-byte chunks may be stored as five chunks, the last two
 * empty. The bar follows the file's own bytes, so it is full when the file is, never past it, and the
 * padding at the end neither moves it nor holds it short of full.
 */
class PaddedProgressTest {
    @Test
    fun `progress follows the file's bytes and padding chunks leave it full`() {
        val seen = ArrayList<Float>()
        val out = File(Files.createTempDirectory("padded").toFile(), "f.bin")
        val plain = ByteArray(10) { it.toByte() }
        Resumable.download(out, 5uL, 4L, sleep = {}, progress = { seen.add(it) }, fileSize = 10L) { index ->
            val start = (index.toLong() * 4).toInt()
            if (start >= plain.size) ByteArray(0) else plain.copyOfRange(start, minOf(plain.size, start + 4))
        }
        assertArrayEquals(plain, out.readBytes())
        assertEquals(listOf(0.4f, 0.8f, 1f, 1f, 1f), seen)
        // An empty file is done only when its one (padding) chunk is.
        assertEquals(0f, Resumable.fraction(0uL, 1uL, 4L, 0L))
        assertEquals(1f, Resumable.fraction(1uL, 1uL, 4L, 0L))
    }
}
