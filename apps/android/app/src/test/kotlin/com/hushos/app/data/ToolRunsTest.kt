package com.hushos.app.data

import com.hushos.core.Content
import com.hushos.core.RunControl
import com.hushos.core.ToolClock
import com.hushos.core.VersionReader
import com.hushos.core.chunkEncrypt
import com.hushos.core.chunkLength
import com.hushos.core.contentLayout
import com.hushos.core.randomBytes
import com.hushos.core.rangeDigest
import com.hushos.core.toolFailedMessage
import com.hushos.core.toolWatchdogMillis
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
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
 * read across a chunk boundary on the run's own thread; one run at a time; cancel, cancelAll and
 * the watchdog ending a run and the thread behind it; the slot never lost to a caller cancelled
 * at the wrong moment; and toolReaderOf against a real HTTP server, renewing an expired address
 * and cutting off a fetch when the run ends. Each test fails if its rule is broken. The watchdog
 * runs on a clock that moves a second each time it is read, so no test depends on how fast
 * this machine is.
 */
class ToolRunsTest {
    private val chunk = 8L * 1024 * 1024

    /* A second each time the core reads it: each watchdog check, and each progress. */
    private class Stepping : ToolClock {
        val now = AtomicLong()
        override fun nowMillis(): ULong = now.addAndGet(1_000).toULong()
    }

    private fun sealed(size: Long): Triple<Content, ByteArray, ByteArray> {
        val plain = ByteArray(size.toInt()) { i -> ((i.toLong() * 2_654_435_761L) ushr 13).toByte() }
        val content = Content("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", 3u,
            randomBytes(32u), randomBytes(16u), size.toULong(), 0u)
        val layout = contentLayout(3u, size.toULong(), 0u)
        val stored = java.io.ByteArrayOutputStream()
        for (index in 0uL until layout.chunkCount) {
            val start = minOf(index.toLong() * chunk, size).toInt()
            val length = chunkLength(size.toULong(), index).toInt()
            stored.write(chunkEncrypt(content, index, plain.copyOfRange(start, start + length)))
        }
        return Triple(content, stored.toByteArray(), plain)
    }

    private fun eventually(condition: () -> Boolean) {
        repeat(500) {
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
        val first = async(Dispatchers.Default) {
            runs.run("Extracting Photos.zip") { log.add("first started"); gate.await(5, TimeUnit.SECONDS); log.add("first ended"); 1 }
        }
        eventually { runs.running.value == "Extracting Photos.zip" }
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        val second = async(Dispatchers.Default) {
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
        val job = async(Dispatchers.Default) {
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

    @Test fun aWaitingRunCancelledNeverStarts() = runBlocking {
        val runs = ToolRuns()
        val gate = CountDownLatch(1)
        val log = Collections.synchronizedList(ArrayList<String>())
        val first = async(Dispatchers.Default) { runs.run("First") { gate.await(5, TimeUnit.SECONDS); 0 } }
        eventually { runs.running.value == "First" }
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        val second = async(Dispatchers.Default) { runs.run("Second", state = { states.add(it) }) { log.add("second ran"); 0 } }
        eventually { states.contains(ToolRunState.Waiting("First")) }
        second.cancel()
        try {
            second.await()
            fail("the waiting run was not cancelled")
        } catch (_: CancellationException) {
        }
        gate.countDown()
        first.await()
        eventually { runs.running.value == null }
        assertTrue(log.isEmpty())
        assertEquals(3, withTimeout(5_000) { runs.run("Next") { 3 } })
    }

    @Test fun aCallerCancelledBeforeItAsksNeverRunsAndLeavesTheSlotFree() = runBlocking {
        val runs = ToolRuns()
        val ran = AtomicInteger()
        val entered = CountDownLatch(1)
        val asking = CountDownLatch(1)
        // Cancelled while busy with something that doesn't look (blocking work), then it asks for a run.
        val job = async(Dispatchers.Default) {
            entered.countDown()
            asking.await(5, TimeUnit.SECONDS)
            runs.run("Too late") { ran.incrementAndGet() }
        }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        job.cancel()
        asking.countDown()
        try {
            job.await()
            fail("the run started")
        } catch (_: CancellationException) {
        }
        assertEquals(0, ran.get())
        // The slot was taken on the way and given back: the next run gets it.
        assertEquals(3, withTimeout(5_000) { runs.run("Next") { 3 } })
    }

    @Test fun cancelAllEndsTheRunningAndTheWaiting() = runBlocking {
        val runs = ToolRuns()
        val log = Collections.synchronizedList(ArrayList<String>())
        val running = async(Dispatchers.Default) {
            runs.run("Running") { control -> while (true) { control.check(); Thread.sleep(5) } }
        }
        eventually { runs.running.value == "Running" }
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        val waiting = async(Dispatchers.Default) { runs.run("Waiting", state = { states.add(it) }) { log.add("waiting ran") } }
        eventually { states.contains(ToolRunState.Waiting("Running")) }
        runs.cancelAll()
        for (job in listOf(running, waiting)) {
            try {
                job.await()
                fail("a run outlived the sign-out")
            } catch (_: CancellationException) {
            }
        }
        eventually { runs.running.value == null }
        assertTrue(log.isEmpty())
    }

    @Test fun aSignOutAsARunIsLetInStartsNothing() = runBlocking {
        // cancelAll from the Running callback: after the slot is taken, before the thread starts.
        val runs = ToolRuns()
        val ran = AtomicInteger()
        try {
            runs.run("Let in", state = { if (it == ToolRunState.Running) runs.cancelAll() }) { ran.incrementAndGet() }
            fail("the run started after the sign-out")
        } catch (_: CancellationException) {
        }
        assertEquals(0, ran.get())
        assertEquals(3, withTimeout(5_000) { runs.run("Next") { 3 } })
    }

    @Test fun aSignOutAsARunStartsWaitingEndsIt() = runBlocking {
        // cancelAll from the Waiting callback: the waiting run is reached, not only the running one.
        val runs = ToolRuns()
        val gate = CountDownLatch(1)
        val ran = AtomicInteger()
        val first = async(Dispatchers.Default) { runs.run("First") { gate.await(5, TimeUnit.SECONDS); 0 } }
        eventually { runs.running.value == "First" }
        val second = async(Dispatchers.Default) {
            runs.run("Second", state = { if (it is ToolRunState.Waiting) runs.cancelAll() }) { ran.incrementAndGet() }
        }
        for (job in listOf(first, second)) {
            try {
                job.await()
                fail("a run outlived the sign-out")
            } catch (_: CancellationException) {
            }
        }
        gate.countDown()
        eventually { runs.running.value == null }
        assertEquals(0, ran.get())
    }

    @Test fun theWatchdogFailsARunThatReportsNoProgress() = runBlocking {
        val runs = ToolRuns()
        val log = Collections.synchronizedList(ArrayList<String>())
        val states = Collections.synchronizedList(ArrayList<ToolRunState>())
        try {
            runs.run("Stuck", pollMillis = 5, clock = Stepping(), state = { states.add(it) }) { control ->
                // A parser looping without progress; it only checks it has not been stopped.
                try {
                    while (true) {
                        control.check()
                        Thread.sleep(1)
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
        assertEquals(ToolRunState.Failed(toolFailedMessage()), states.last())
        eventually { log.contains("stopped") }
    }

    @Test fun progressKeepsTheWatchdogAway() = runBlocking {
        // Many more checks than the watchdog's 30 seconds, each a second: only progress keeps the run alive.
        val value = ToolRuns().run("Slow but alive", pollMillis = 2, clock = Stepping()) { control ->
            repeat(400) {
                Thread.sleep(1)
                control.progress()
            }
            7
        }
        assertEquals(7, value)
    }

    /* A store and API on this machine: version addresses that expire after one use, and ranges. */
    private class Server(private val stored: ByteArray) : AutoCloseable {
        val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val origin = "http://127.0.0.1:${server.address.port}"
        val addresses = AtomicInteger()
        val refused = AtomicInteger()
        val ranges = Collections.synchronizedList(ArrayList<String>())
        val stalled = AtomicInteger()
        /* While set, the store holds every range open until released (a stalled network). */
        @Volatile var stall: CountDownLatch? = null

        init {
            server.createContext("/api/drive/versions/") { exchange ->
                val body = """{"url":"$origin/store/o?n=${addresses.incrementAndGet()}","urlExpiresAt":null}""".toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            server.createContext("/store/o") { exchange ->
                // The first address has expired by the time it is used.
                if (exchange.requestURI.query == "n=1") {
                    refused.incrementAndGet()
                    exchange.sendResponseHeaders(403, -1)
                    exchange.close()
                    return@createContext
                }
                stall?.let { stalled.incrementAndGet(); it.await(10, TimeUnit.SECONDS) }
                val header = exchange.requestHeaders.getFirst("Range")
                ranges.add(header)
                val (start, end) = header.removePrefix("bytes=").split("-").map { it.toInt() }
                val body = stored.copyOfRange(start, end + 1)
                exchange.sendResponseHeaders(206, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            server.executor = java.util.concurrent.Executors.newCachedThreadPool()
            server.start()
        }

        override fun close() = server.stop(0)
    }

    @Test fun toolReaderOfReadsRangesAndRenewsAnExpiredAddress() {
        val size = chunk + 5000
        val (content, stored, plain) = sealed(size)
        Server(stored).use { server ->
            val api = DriveApi(Shared.Session(server.origin, "token", "user"))
            val control = RunControl(toolWatchdogMillis(), null)
            val reader = toolReaderOf(api, OpenedVersion(content, "v1"), "ws", control)
            assertArrayEquals(plain.copyOfRange((chunk - 10).toInt(), (chunk + 10).toInt()), reader.readAt((chunk - 10).toULong(), 20uL))
            assertEquals(1, server.refused.get())
            assertEquals(2, server.addresses.get())
            assertEquals(2, server.ranges.size)
        }
    }

    @Test fun aRunThatEndsCutsOffItsFetch() {
        val (content, stored, _) = sealed(1000)
        Server(stored).use { server ->
            val api = DriveApi(Shared.Session(server.origin, "token", "user"))
            val control = RunControl(toolWatchdogMillis(), null)
            val reader = toolReaderOf(api, OpenedVersion(content, "v1"), "ws", control)
            val stall = CountDownLatch(1)
            server.stall = stall
            val failed = AtomicInteger()
            val reading = Thread { try { reader.readAt(0uL, 10uL) } catch (_: Exception) { failed.incrementAndGet() } }
            reading.start()
            // Held open by the store, past the expired address's renewal.
            eventually { server.stalled.get() == 1 }
            val cancelled = System.nanoTime()
            control.cancel()
            reading.join(5_000)
            stall.countDown()
            assertFalse("the fetch outlived its run", reading.isAlive)
            assertEquals(1, failed.get())
            assertTrue((System.nanoTime() - cancelled) / 1_000_000 < 2_000)
        }
    }
}
