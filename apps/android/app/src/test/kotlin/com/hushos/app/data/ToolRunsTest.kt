package com.hushos.app.data

import com.hushos.core.Content
import com.hushos.core.VersionReader
import com.hushos.core.chunkEncrypt
import com.hushos.core.chunkLength
import com.hushos.core.contentLayout
import com.hushos.core.randomBytes
import com.hushos.core.rangeDigest
import com.hushos.core.toolFailedMessage
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * The harness file tools run in: the core's reader over an object served through StoreSource,
 * read across a chunk boundary on the run's own thread; one run at a time; cancel and the
 * watchdog ending a run and the thread behind it. Each test fails if its rule is broken: a second
 * run starting beside the first, a cancel that leaves the work running, a run that hangs without
 * progress and is never stopped.
 */
class ToolRunsTest {
    private val chunk = 8L * 1024 * 1024

    private fun sealed(size: Long): Triple<Content, ByteArray, ByteArray> {
        val plain = ByteArray(size.toInt()) { i -> ((i.toLong() * 2_654_435_761L) ushr 13).toByte() }
        val content = Content("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", 3u,
            randomBytes(32u), randomBytes(16u), size.toULong(), 0u)
        val layout = contentLayout(3u, size.toULong(), 0u)
        val object_ = java.io.ByteArrayOutputStream()
        for (index in 0uL until layout.chunkCount) {
            val start = minOf(index.toLong() * chunk, size).toInt()
            val length = chunkLength(size.toULong(), index).toInt()
            object_.write(chunkEncrypt(content, index, plain.copyOfRange(start, start + length)))
        }
        return Triple(content, object_.toByteArray(), plain)
    }

    private fun eventually(condition: () -> Boolean) {
        repeat(300) {
            if (condition()) return
            Thread.sleep(10)
        }
        fail("the condition never held")
    }

    @Test fun aRunReadsAcrossAChunkBoundaryThroughTheStore() = runBlocking {
        val size = chunk + 5000
        val (content, stored, plain) = sealed(size)
        val fetches = Collections.synchronizedList(ArrayList<Long>())
        val source = StoreSource { range ->
            fetches.add(range.start.toLong())
            stored.copyOfRange(range.start.toInt(), range.end.toInt() + 1)
        }
        val digest = ToolRuns().run("Digest") { control ->
            val reader = VersionReader(source, content, control)
            rangeDigest(reader, control, (chunk - 100).toULong(), 300uL)
        }
        val expected = MessageDigest.getInstance("SHA-256").digest(plain.copyOfRange((chunk - 100).toInt(), (chunk + 200).toInt()))
        assertArrayEquals(expected, digest)
        assertEquals(2, fetches.size)
    }

    @Test fun aStoreFailureFailsTheRunWithTheGenericWords() = runBlocking {
        val (content, _, _) = sealed(1000)
        val source = StoreSource { throw ApiError(404, "gone") }
        try {
            ToolRuns().run("Digest") { control -> rangeDigest(VersionReader(source, content, control), control, 0uL, 10uL) }
            fail("the run succeeded")
        } catch (error: ToolFailed) {
            assertEquals(toolFailedMessage(), error.message)
        }
    }

    @Test fun aSecondRunWaitsBehindTheFirstAndStartsWhenItEnds() = runBlocking {
        val runs = ToolRuns()
        val gate = CountDownLatch(1)
        val log = Collections.synchronizedList(ArrayList<String>())
        val first = async(kotlinx.coroutines.Dispatchers.Default) {
            runs.run("Extracting Photos.zip") { log.add("first started"); gate.await(5, TimeUnit.SECONDS); log.add("first ended"); 1 }
        }
        eventually { runs.running.value == "Extracting Photos.zip" }
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        val second = async(kotlinx.coroutines.Dispatchers.Default) {
            runs.run("Converting 3 photos", state = { states.add(it) }) { log.add("second started"); 2 }
        }
        eventually { states.contains(ToolRunState.Waiting("Extracting Photos.zip")) }
        assertFalse(log.contains("second started"))
        gate.countDown()
        assertEquals(1, first.await())
        assertEquals(2, second.await())
        assertEquals(listOf("first started", "first ended", "second started"), log.toList())
        eventually { runs.running.value == null }
    }

    @Test fun cancelEndsTheRunAndStopsItsThreadAtTheNextCall() = runBlocking {
        val runs = ToolRuns()
        val log = Collections.synchronizedList(ArrayList<String>())
        val job = async(kotlinx.coroutines.Dispatchers.Default) {
            runs.run("Compressing") { control ->
                log.add("started")
                // Busy, reporting progress: only the cancel can end it.
                try {
                    while (true) {
                        control.progress()
                        Thread.sleep(5)
                    }
                } catch (error: Exception) {
                    log.add("stopped")
                    throw error
                }
            }
        }
        eventually { log.contains("started") }
        job.cancel()
        try {
            job.await()
            fail("the run was not cancelled")
        } catch (_: CancellationException) {
        }
        eventually { log.contains("stopped") }
        eventually { runs.running.value == null }
        assertEquals(3, withTimeout(5_000) { runs.run("Next") { 3 } })
    }

    @Test fun theWatchdogFailsARunThatReportsNoProgress() = runBlocking {
        val runs = ToolRuns()
        val log = Collections.synchronizedList(ArrayList<String>())
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        val started = System.nanoTime()
        try {
            runs.run("Stuck", watchdogMillis = 300, pollMillis = 20, state = { states.add(it) }) { control ->
                // A parser looping without progress; it only checks it has not been stopped.
                try {
                    while (true) {
                        control.check()
                        Thread.sleep(5)
                    }
                } catch (error: Exception) {
                    log.add("stopped")
                    throw error
                }
            }
            fail("the run never timed out")
        } catch (error: ToolFailed) {
            assertEquals(toolFailedMessage(), error.message)
        }
        assertTrue((System.nanoTime() - started) / 1_000_000 >= 300)
        assertEquals(ToolRunState.Failed(toolFailedMessage()), states.last())
        eventually { log.contains("stopped") }
    }

    @Test fun progressKeepsTheWatchdogAway() = runBlocking {
        val value = ToolRuns().run("Slow but alive", watchdogMillis = 200, pollMillis = 20) { control ->
            repeat(10) {
                Thread.sleep(50)
                control.progress()
            }
            7
        }
        assertEquals(7, value)
    }
}
