package com.hushos.app.data

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * WorkManager stops a worker (its coroutine is cancelled) while its thread is still inside the blocking upload, then
 * starts the rescheduled run. That run must wait until the old one's work has returned, or it sends the file again
 * before the old one can leave its LandedJobs mark.
 */
class JobLocksTest {
    @Test
    fun aRerunWaitsForTheStoppedRunsWorkToReturn() = runBlocking {
        val events = Collections.synchronizedList(ArrayList<String>())
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val worker = CoroutineScope(Job() + Dispatchers.Default)
        val first = worker.launch {
            JobLocks.run("job-1") {
                withContext(Dispatchers.IO) {
                    inside.countDown()
                    release.await(5, TimeUnit.SECONDS)
                    events.add("first run's upload returned")
                }
            }
        }
        assertTrue(inside.await(5, TimeUnit.SECONDS))
        // WorkManager stops the first run and starts the rerun at once.
        first.cancel()
        val rerun = CoroutineScope(Dispatchers.Default).async { JobLocks.run("job-1") { events.add("rerun started") } }
        Thread.sleep(300)
        assertEquals("the rerun waited", emptyList<String>(), events.toList())
        release.countDown()
        rerun.await()
        first.join()
        assertEquals(listOf("first run's upload returned", "rerun started"), events.toList())
    }

    @Test
    fun anotherJobIsNotHeldUp() = runBlocking {
        val release = CountDownLatch(1)
        val inside = CountDownLatch(1)
        val holder = CoroutineScope(Dispatchers.Default).launch {
            JobLocks.run("job-a") { withContext(Dispatchers.IO) { inside.countDown(); release.await(5, TimeUnit.SECONDS) } }
        }
        assertTrue(inside.await(5, TimeUnit.SECONDS))
        assertEquals("ran", JobLocks.run("job-b") { "ran" })
        release.countDown()
        holder.join()
    }
}
