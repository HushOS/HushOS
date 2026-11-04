package com.hushos.app.files

import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/*
 * A pull-down in Files (ContentProvider.refresh): a sync now, then the folder told to ask again. The sync is queued on
 * the provider's own executor, so one already running finishes first and this one runs right after it, never beside it.
 * The binder thread waits at most `waitMs`, and less when the caller cancels; whatever happens to the wait, the folder
 * is told once the sync has run, so a slow pull still lands. True only when the sync ran and reached the server in time,
 * so Files reloads by itself otherwise.
 */
object ProviderRefresh {
    fun run(submit: (Callable<Boolean>) -> Future<Boolean>, sync: () -> Boolean, tell: () -> Unit, waitMs: Long, cancelled: () -> Boolean): Boolean {
        val pending = submit(Callable {
            val pulled = runCatching { sync() }.getOrDefault(false)
            runCatching { tell() }
            pulled
        })
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs)
        while (true) {
            if (cancelled()) return false
            val left = deadline - System.nanoTime()
            if (left <= 0) return false
            try {
                return pending.get(minOf(left, TimeUnit.MILLISECONDS.toNanos(STEP_MS)), TimeUnit.NANOSECONDS)
            } catch (waiting: TimeoutException) {
                continue
            } catch (failed: ExecutionException) {
                return false
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
        }
    }

    /* How often a wait looks at the cancellation signal. */
    private const val STEP_MS = 100L
}
