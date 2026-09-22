package com.hushos.app.data

import android.content.Context
import android.net.ConnectivityManager
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/*
 * Transfers that survive a bad connection, as the web's do. A piece (a chunk
 * down, a part up) that fails because of the network is tried again after a
 * jittered backoff; while the phone has no network at all it waits for one
 * and the wait does not count as a failed try. An answer a retry cannot
 * change (a 4xx other than 403, 408 and 429) fails at once; a 403 is an
 * expired address, fetched fresh before the next try.
 *
 * A download keeps its `.part` file between tries and between launches: the
 * next attempt continues from the last whole chunk rather than from zero.
 */
object Resumable {
    const val MAX_ATTEMPTS = 8
    private const val OFFLINE_LIMIT_MS = 10 * 60_000L

    /* 1 s, 2 s, 4 s… up to a minute, each somewhere in its upper half so retries from many pieces do not land together. */
    fun delayMs(attempt: Int, random: Double = Math.random()): Long {
        val ceiling = minOf(60_000L, 1_000L shl (attempt - 1).coerceIn(0, 6))
        return ceiling / 2 + (ceiling / 2 * random).toLong()
    }

    fun retryable(error: Throwable): Boolean = when (error) {
        is Unreachable, is IOException -> true
        is ApiError -> error.status == 403 || error.status == 408 || error.status == 429 || error.status >= 500 || error.status == 0
        else -> false
    }

    fun online(context: Context?): Boolean =
        context == null || context.getSystemService(ConnectivityManager::class.java)?.activeNetwork != null

    /*
     * Runs `step` until it succeeds, retrying what the network broke. `online` and
     * `sleep` are parameters so a test can play out an outage without waiting.
     */
    fun <T> run(
        online: () -> Boolean = { true },
        sleep: (Long) -> Unit = Thread::sleep,
        onExpired: () -> Unit = {},
        step: () -> T,
    ): T {
        var attempt = 0
        var offlineFor = 0L
        while (true) {
            try {
                return step()
            } catch (error: Exception) {
                if (!retryable(error)) throw error
                if (error is ApiError && error.status == 403) onExpired()
                if (!online()) {
                    // No network: wait for one without spending a try, up to a limit.
                    if (offlineFor >= OFFLINE_LIMIT_MS) throw error
                    sleep(1_000); offlineFor += 1_000
                    continue
                }
                attempt++
                if (attempt >= MAX_ATTEMPTS) throw error
                sleep(delayMs(attempt))
            }
        }
    }

    /*
     * Fetches chunks `0 until count` into `destination`, each `chunkBytes` of plaintext
     * but the last, continuing a `.part` left by an earlier try from its last whole chunk.
     * `fetch` returns one chunk's plaintext; it is retried through `run`.
     */
    fun download(
        destination: File,
        count: ULong,
        chunkBytes: Long,
        online: () -> Boolean = { true },
        sleep: (Long) -> Unit = Thread::sleep,
        onExpired: () -> Unit = {},
        progress: (Float) -> Unit = {},
        fetch: (ULong) -> ByteArray,
    ) {
        destination.parentFile?.mkdirs()
        val partial = File(destination.path + ".part")
        val kept = if (partial.exists()) (partial.length() / chunkBytes).toULong().coerceAtMost(count) else 0uL
        RandomAccessFile(partial, "rw").use { file ->
            // Whatever came after the last whole chunk may be cut short: drop it and fetch that chunk again.
            file.setLength(kept.toLong() * chunkBytes)
            file.seek(file.length())
            for (index in kept until count) {
                file.write(run(online, sleep, onExpired) { fetch(index) })
                progress((index + 1uL).toFloat() / count.toFloat())
            }
        }
        if (destination.exists()) destination.delete()
        if (!partial.renameTo(destination)) throw IOException("Could not keep ${destination.name}")
    }
}
