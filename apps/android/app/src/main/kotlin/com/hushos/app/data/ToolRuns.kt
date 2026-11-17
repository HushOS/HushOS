package com.hushos.app.data

import com.hushos.core.ByteRange
import com.hushos.core.FetchException
import com.hushos.core.ObjectSource
import com.hushos.core.RunControl
import com.hushos.core.VersionReader
import com.hushos.core.toolBudgetBytes
import com.hushos.core.toolFailedMessage
import com.hushos.core.toolWatchdogMillis
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlin.coroutines.cancellation.CancellationException

/*
 * The harness file tools run in (docs/file-tools-design.md, sections 2, 3 and 6), as the web's
 * workers do: one run at a time, a run started meanwhile waiting behind it; cancel; a watchdog
 * that stops a run reporting no progress for 30 seconds; and the 512 MiB budget of produced
 * plaintext waiting for upload. The core holds the run's control (RunControl), the seekable
 * decrypting reader (VersionReader) and the budget; this holds the order and the clock.
 *
 * Each run's work is the core's, blocking, so it runs on a thread of its own. A thread cannot be
 * killed: cancel and the watchdog end the run for the caller at once and fail the work's next
 * read, produce or progress call, which stops it. The next run starts only once that thread has
 * really returned, so two runs never hold memory together; a tool that loops without calling the
 * core holds the queue until it returns.
 */

sealed interface ToolRunState {
    data class Waiting(val behind: String) : ToolRunState
    data object Running : ToolRunState
    data object Done : ToolRunState
    data class Failed(val message: String) : ToolRunState
    data object Cancelled : ToolRunState
}

/* A run that failed, in the person's words: the watchdog, or a tool that could not read the file. */
class ToolFailed(message: String = toolFailedMessage(), cause: Throwable? = null) : Exception(message, cause)

class ToolRuns {
    private val slot = Mutex()
    private val current = MutableStateFlow<String?>(null)

    /* The run going now, by its label; null when none is. */
    val running: StateFlow<String?> get() = current

    /*
     * Runs `work` when no other run is going, on a thread of its own, under a fresh RunControl: the
     * work passes it to the core's reader and tools. `label` names the run to one waiting behind it
     * ("Extracting Photos.zip"). Throws CancellationException when the calling coroutine is
     * cancelled (waiting or running), ToolFailed when the watchdog fires or the work throws.
     */
    suspend fun <T> run(
        label: String,
        budgetBytes: ULong = toolBudgetBytes(),
        watchdogMillis: Long = toolWatchdogMillis().toLong(),
        pollMillis: Long = 1_000,
        state: (ToolRunState) -> Unit = {},
        work: (RunControl) -> T,
    ): T {
        // Mutex is fair: first come, first run. While waiting, told whenever the run ahead changes.
        coroutineScope {
            val waiting = launch { current.collect { ahead -> if (ahead != null) state(ToolRunState.Waiting(ahead)) } }
            try {
                slot.lock()
            } catch (error: CancellationException) {
                state(ToolRunState.Cancelled)
                throw error
            } finally {
                waiting.cancel()
            }
        }
        current.value = label
        state(ToolRunState.Running)
        val control = RunControl(budgetBytes, watchdogMillis.toULong())
        val outcome = CompletableDeferred<Result<T>>()
        val thread = Thread(null, {
            try {
                val result = runCatching { work(control) }
                outcome.complete(result.recoverCatching { error ->
                    when {
                        control.isCancelled() -> throw CancellationException("Cancelled.")
                        control.timedOut() -> throw ToolFailed()
                        error is ToolFailed -> throw error
                        // The person sees the generic words; the cause stays for logs and tests.
                        else -> throw ToolFailed(cause = error)
                    }
                })
            } finally {
                // The slot frees once this thread has returned, whether or not the caller still waits for it.
                current.value = null
                slot.unlock()
            }
        }, "tool-run", 8L shl 20)
        thread.start()
        try {
            val value = coroutineScope {
                val watchdog = launch(Dispatchers.Default) {
                    while (true) {
                        delay(pollMillis)
                        if (control.checkWatchdog()) {
                            outcome.complete(Result.failure(ToolFailed()))
                            return@launch
                        }
                    }
                }
                try {
                    outcome.await().getOrThrow()
                } finally {
                    watchdog.cancel()
                }
            }
            state(ToolRunState.Done)
            return value
        } catch (error: Throwable) {
            control.cancel()
            state(if (error is CancellationException) ToolRunState.Cancelled else ToolRunState.Failed(error.message ?: toolFailedMessage()))
            throw error
        }
    }

    companion object {
        val shared = ToolRuns()
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

/*
 * A seekable, decrypting reader over a file's version for a tool run under `control`: each chunk it
 * reads is fetched by range (retried as downloads are, the address renewed when it expires) and
 * opened in the core, which keeps only the chunks being read, in memory.
 */
fun Vault.toolReader(item: Opened, control: RunControl, version: VersionListView? = null): VersionReader {
    val opened = openVersion(item, version)
    val workspaceId = item.node.workspaceId
    val url = AtomicReference(api.versionUrl(opened.versionId, workspaceId))
    val source = StoreSource { range ->
        Resumable.run(online = { Resumable.online(context) }, onExpired = { url.set(api.versionUrl(opened.versionId, workspaceId)) }) {
            api.range(url.get(), range)
        }
    }
    return VersionReader(source, opened.content, control)
}
