package com.hushos.app.data

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.cancellation.CancellationException

/*
 * A request whose screen goes away mid-way (a rememberCoroutineScope leaving the composition, a LaunchedEffect
 * restarting) is cancelled, not failed: nothing may be reported. These run the owner's case as it happened, a
 * request on the IO dispatcher whose scope is cancelled with Compose's own words while it is under way.
 */
class AttemptTest {
    private val leftComposition = CancellationException("The coroutine was canceled because it left the composition")

    /* Starts `request` in a scope like a screen's, cancels the scope while the request blocks, and returns what was reported. */
    private fun cancelMidway(request: suspend (block: () -> Unit, report: (Throwable) -> Unit) -> Unit): List<Throwable> {
        val reported = java.util.Collections.synchronizedList(ArrayList<Throwable>())
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val screen = CoroutineScope(Job() + Dispatchers.Default)
        val job = screen.launch {
            request({ started.countDown(); release.await(5, TimeUnit.SECONDS) }) { reported.add(it) }
        }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        screen.coroutineContext[Job]!!.cancel(leftComposition)
        release.countDown()
        runBlocking { job.join() }
        assertTrue(job.isCancelled)
        return reported
    }

    @Test
    fun aCancelledRequestReportsNothing() {
        val reported = cancelMidway { block, report ->
            attempt { withContext(Dispatchers.IO) { block() } }.onFailure(report)
        }
        assertEquals(emptyList<Throwable>(), reported)
    }

    @Test
    fun aCatchAroundSuspendingWorkLetsCancellationThrough() {
        val reported = cancelMidway { block, report ->
            try {
                withContext(Dispatchers.IO) { block() }
            } catch (error: Exception) {
                error.rethrowIfCancelled()
                report(error)
            }
        }
        assertEquals(emptyList<Throwable>(), reported)
    }

    @Test
    fun aRealFailureIsStillReported() = runBlocking {
        val failure = attempt { withContext(Dispatchers.IO) { throw ApiError(500, "boom") } }.exceptionOrNull()
        assertTrue(failure is ApiError)
        var reported: Throwable? = null
        try {
            withContext(Dispatchers.IO) { throw Unreachable() }
        } catch (error: Exception) {
            error.rethrowIfCancelled()
            reported = error
        }
        assertTrue(reported is Unreachable)
    }
}
