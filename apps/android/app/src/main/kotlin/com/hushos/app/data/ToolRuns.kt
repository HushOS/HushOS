package com.hushos.app.data

import com.hushos.core.ByteRange
import com.hushos.core.FetchException
import com.hushos.core.ObjectSource
import com.hushos.core.RunControl
import com.hushos.core.ToolBudget
import com.hushos.core.ToolClock
import com.hushos.core.VersionReader
import com.hushos.core.toolBudgetBytes
import com.hushos.core.toolFailedMessage
import com.hushos.core.toolWatchdogMillis
import java.net.HttpURLConnection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlin.coroutines.cancellation.CancellationException

/*
 * The harness file tools run in (docs/file-tools-design.md, sections 2, 3 and 6), as the web's
 * workers do: one run at a time, a run started meanwhile waiting behind it; cancel; a watchdog
 * that stops a run reporting no progress for 30 seconds; and the 512 MiB budget of produced
 * plaintext waiting for upload, one for the process (`ToolRuns.budget`). The core holds the
 * run's control (RunControl), the seekable decrypting reader (VersionReader) and the budget;
 * this holds the order and the clock.
 *
 * Each run's work is the core's, blocking, so it runs on a thread of its own. A thread cannot be
 * killed: cancel and the watchdog end the run for the caller at once and fail the work's next
 * read, produce or progress call, which stops it; a fetch in flight is cut off (toolReader). The
 * next run starts only once that thread has really returned, so two runs never hold memory
 * together; a tool that loops without calling the core holds the queue until it returns.
 */

sealed interface ToolRunState {
    data class Waiting(val behind: String) : ToolRunState
    data object Running : ToolRunState
    data object Done : ToolRunState
    data class Failed(val message: String) : ToolRunState
    data object Cancelled : ToolRunState
}

/* A run that failed, in the person's words: the watchdog, or a tool that could not read the file. The cause stays for logs and tests. */
class ToolFailed(message: String = toolFailedMessage(), cause: Throwable? = null) : Exception(message, cause)

class ToolRuns {
    private val slot = Mutex()
    private val current = MutableStateFlow<String?>(null)
    /* Every run of this harness, running or waiting, by what ends it: what a sign-out calls. */
    private val live = ConcurrentHashMap.newKeySet<() -> Unit>()

    /* The run going now, by its label; null when none is. */
    val running: StateFlow<String?> get() = current

    private fun track(end: () -> Unit): () -> Unit {
        live.add(end)
        return { live.remove(end) }
    }

    /* Sign-out and account removal: every run ends, running or waiting, and none starts. */
    fun cancelAll() {
        for (end in live.toList()) end()
    }

    /*
     * Runs `work` when no other run is going, on a thread of its own, under a fresh RunControl:
     * the work passes it to the core's reader and tools, and produces into `budget`. `label`
     * names the run to one waiting behind it ("Extracting Photos.zip"). Throws
     * CancellationException when the calling coroutine is cancelled (waiting or running) or
     * cancelAll ends it, ToolFailed when the watchdog fires or the work throws.
     */
    suspend fun <T> run(
        label: String,
        watchdogMillis: Long = toolWatchdogMillis().toLong(),
        pollMillis: Long = 1_000,
        clock: ToolClock? = null,
        state: (ToolRunState) -> Unit = {},
        work: (RunControl) -> T,
    ): T {
        // This run's own claim on the slot: unlocked here unless the thread took it over.
        val token = Any()
        var handedOver = false
        val control = RunControl(watchdogMillis.toULong(), clock)
        val outcome = CompletableDeferred<Result<T>>()
        // One cancellation for the run's whole life, in place before anything is announced: a
        // sign-out reaches it waiting, being let in, or running. The control is the latch.
        val waiting = AtomicReference<kotlinx.coroutines.Job?>(null)
        val untrack = track {
            control.cancel()
            outcome.complete(Result.failure(CancellationException("Cancelled.")))
            waiting.get()?.cancel(CancellationException("Cancelled."))
        }
        try {
            try {
                coroutineScope {
                    waiting.set(coroutineContext[kotlinx.coroutines.Job]!!)
                    // Ended before it could wait (a sign-out from the state callback of another run).
                    if (control.isEnded()) throw CancellationException("Cancelled.")
                    // Fair: first come, first run. While waiting, told whenever the run ahead changes.
                    val watch = launch { current.collect { ahead -> if (ahead != null) state(ToolRunState.Waiting(ahead)) } }
                    try {
                        slot.lock(token)
                    } finally {
                        watch.cancel()
                        waiting.set(null)
                    }
                }
                // Mutex's fast path takes a free slot without looking: a caller already cancelled stops here.
                currentCoroutineContext().ensureActive()
                if (control.isEnded()) throw CancellationException("Cancelled.")
                current.value = label
                state(ToolRunState.Running)
                // A sign-out from the Running callback, or any time until the thread starts: nothing starts.
                if (control.isEnded()) throw CancellationException("Cancelled.")
            } catch (error: CancellationException) {
                untrack()
                state(ToolRunState.Cancelled)
                throw error
            }
            val thread = Thread(null, {
                try {
                    val result = runCatching { work(control) }
                    outcome.complete(result.recoverCatching { error ->
                        when {
                            control.isCancelled() -> throw CancellationException("Cancelled.")
                            control.timedOut() -> throw ToolFailed()
                            error is ToolFailed -> throw error
                            else -> throw ToolFailed(cause = error)
                        }
                    })
                } finally {
                    untrack()
                    current.value = null
                    slot.unlock(token)
                }
            }, "tool-run", 8L shl 20)
            handedOver = true
            try {
                thread.start()
            } catch (error: Throwable) {
                handedOver = false
                untrack()
                throw ToolFailed(cause = error)
            }
            try {
                // On a timer thread of its own: a watchdog on a shared pool waits behind whatever else runs there.
                val watchdog = Timers.every(pollMillis) {
                    if (control.checkWatchdog()) outcome.complete(Result.failure(ToolFailed()))
                }
                val value = try {
                    outcome.await().getOrThrow()
                } finally {
                    watchdog.cancel(false)
                }
                state(ToolRunState.Done)
                return value
            } catch (error: Throwable) {
                control.cancel()
                state(if (error is CancellationException) ToolRunState.Cancelled else ToolRunState.Failed(error.message ?: toolFailedMessage()))
                throw error
            }
        } finally {
            if (!handedOver && slot.holdsLock(token)) {
                current.value = null
                slot.unlock(token)
            }
        }
    }

    companion object {
        val shared = ToolRuns()

        /*
         * Produced plaintext waiting for upload, for the whole process: a finished run's results
         * still count until the save path releases each one (uploaded or dropped).
         */
        val budget: ToolBudget = ToolBudget(toolBudgetBytes())
    }
}

/*
 * The object store as the core's VersionReader reaches it: `fetch` is called on the run's own
 * thread, where blocking on the network is what it is for. A failure reaches the core in its
 * words (FetchError), and the read fails with them.
 */
class StoreSource(private val fetchRange: (ByteRange) -> ByteArray) : ObjectSource {
    override fun fetch(range: ByteRange): ByteArray = try {
        fetchRange(range)
    } catch (error: Exception) {
        throw FetchException.Failed(error.message ?: "The file couldn't be read.")
    }
}

/* The harness's own timer thread: the watchdogs and the cut-offs, never behind a shared pool. */
private object Timers {
    private val timer = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "tool-timers").apply { isDaemon = true } }

    fun every(millis: Long, task: () -> Unit): java.util.concurrent.ScheduledFuture<*> =
        timer.scheduleWithFixedDelay({ runCatching(task) }, millis, millis, TimeUnit.MILLISECONDS)
}

/* Cuts off a connection whose run has ended, within a tenth of a second. */
private object Cutoff {
    fun <T> whileRunning(control: RunControl, connection: HttpURLConnection, block: () -> T): T {
        val watch = Timers.every(100) { if (control.isEnded()) connection.disconnect() }
        try {
            return block()
        } finally {
            watch.cancel(false)
        }
    }
}

/* A wait between tries that ends, failing, as soon as the run does. */
private fun sleepWhileRunning(control: RunControl, millis: Long) {
    var left = millis
    while (left > 0) {
        control.check()
        val step = minOf(left, 100L)
        Thread.sleep(step)
        left -= step
    }
    control.check()
}

/*
 * A reader over `opened` for a run under `control`: each chunk's range fetched through `api`,
 * retried as downloads are, the address renewed when it expires, and given up as soon as the run
 * ends (a wait between tries, an offline wait, or a connection in flight).
 */
fun toolReaderOf(api: DriveApi, opened: OpenedVersion, workspaceId: String, control: RunControl, online: () -> Boolean = { true }): VersionReader {
    val url = AtomicReference(api.versionUrl(opened.versionId, workspaceId))
    val source = StoreSource { range ->
        Resumable.run(
            online = online,
            sleep = { millis -> sleepWhileRunning(control, millis) },
            onExpired = { url.set(api.versionUrl(opened.versionId, workspaceId)) },
        ) {
            control.check()
            api.range(url.get(), range) { connection, request -> Cutoff.whileRunning(control, connection, request) }
        }
    }
    return VersionReader(source, opened.content, control)
}

/* A seekable, decrypting reader over a file's version for a tool run under `control` (toolReaderOf). */
fun Vault.toolReader(item: Opened, control: RunControl, version: VersionListView? = null): VersionReader =
    toolReaderOf(api, openVersion(item, version), item.node.workspaceId, control) { Resumable.online(context) }
