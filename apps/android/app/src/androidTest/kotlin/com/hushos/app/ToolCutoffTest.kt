package com.hushos.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hushos.app.data.DriveApi
import com.hushos.app.data.OpenedVersion
import com.hushos.app.data.PaddingDrains
import com.hushos.app.data.Shared
import com.hushos.app.data.toolReaderOf
import com.hushos.core.ByteRange
import com.hushos.core.Content
import com.hushos.core.RunControl
import com.hushos.core.randomBytes
import com.hushos.core.toolWatchdogMillis
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/*
 * The tool harness's cut-offs on Android's own networking stack, not the host JVM's the unit
 * tests use: a run's end cutting off a range or an address request that trickles, and a padding
 * drain's deadline cutting off a range. Run by hand on an emulator (AGENTS.md, "Tools on a
 * device"); CI runs no instrumented tests. Each logs its timing under the tag EmulatorCutoff.
 */
@RunWith(AndroidJUnit4::class)
class ToolCutoffTest {
    /* An address for /api/drive/versions/..., and a 100-byte body a byte a tenth of a second for anything else. */
    private class Trickle(val trickleAddress: Boolean = false) : AutoCloseable {
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${socket.localPort}"
        private val pool = Executors.newCachedThreadPool()

        init {
            pool.execute {
                while (!socket.isClosed) {
                    val client = runCatching { socket.accept() }.getOrNull() ?: break
                    pool.execute { serve(client) }
                }
            }
        }

        private fun serve(client: Socket) {
            runCatching {
                client.use {
                    val reader = it.getInputStream().bufferedReader()
                    val first = reader.readLine() ?: return
                    while (reader.readLine()?.isNotEmpty() == true) {}
                    val out = it.getOutputStream()
                    val address = first.contains("/api/drive/versions/")
                    if (address && !trickleAddress) {
                        val body = """{"url":"$origin/store/o","urlExpiresAt":null}""".toByteArray()
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        out.write(body)
                        out.flush()
                        return
                    }
                    out.write("HTTP/1.1 ${if (address) "200 OK" else "206 Partial Content"}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".toByteArray())
                    out.flush()
                    repeat(100) {
                        out.write(' '.code)
                        out.flush()
                        Thread.sleep(100)
                    }
                }
            }
        }

        override fun close() {
            socket.close()
            pool.shutdownNow()
        }
    }

    private fun content() = Content("11111111-1111-4111-8111-111111111111", "66666666-6666-4666-8666-666666666666", 3u,
        randomBytes(32u), randomBytes(16u), 1000uL, 0u)

    @Test fun aDrainsDeadlineCutsOffATricklingRange() {
        Trickle().use { trickle ->
            val api = DriveApi(Shared.Session(trickle.origin, "t", "u"))
            val drains = PaddingDrains(maxBytes = 1L shl 20, maxMillis = 300, maxWaiting = 4)
            val next = CountDownLatch(1)
            val started = System.nanoTime()
            drains.enqueue(listOf(ByteRange(0uL, 99uL)), drains.generation) { range, watch ->
                api.range("${trickle.origin}/store/o", range) { call, request -> watch(call); request() }
            }
            drains.enqueue(listOf(ByteRange(0uL, 0uL)), drains.generation) { _, _ -> next.countDown() }
            assertTrue(next.await(15, TimeUnit.SECONDS))
            val millis = (System.nanoTime() - started) / 1_000_000
            Log.i("EmulatorCutoff", "drain: 300 ms deadline, next drain began after $millis ms")
            assertTrue("the deadline took $millis ms", millis < 2_000)
        }
    }

    private fun runEnd(trickleAddress: Boolean, label: String) {
        Trickle(trickleAddress).use { trickle ->
            val api = DriveApi(Shared.Session(trickle.origin, "t", "u"))
            val control = RunControl(toolWatchdogMillis(), null)
            val ended = CountDownLatch(1)
            Thread {
                runCatching { toolReaderOf(api, OpenedVersion(content(), "v1"), "ws", control).readAt(0uL, 10uL) }
                ended.countDown()
            }.start()
            Thread.sleep(500)
            val cancelled = System.nanoTime()
            control.cancel()
            assertTrue(ended.await(15, TimeUnit.SECONDS))
            val millis = (System.nanoTime() - cancelled) / 1_000_000
            Log.i("EmulatorCutoff", "$label: the run's thread returned $millis ms after the cancel")
            assertTrue("$label took $millis ms", millis < 2_000)
        }
    }

    @Test fun aRunsEndCutsOffATricklingRange() = runEnd(false, "range")

    @Test fun aRunsEndCutsOffATricklingAddress() = runEnd(true, "address")
}
