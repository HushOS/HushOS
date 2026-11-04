package com.hushos.app.files

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/*
 * Files' pull-down on the provider's own single-thread executor, as the provider runs it. A refresh must sync after any
 * pull already running (never report the older one's result), tell the folder, and never hold the binder past its wait
 * or past a cancellation; a sync slower than the wait still tells the folder once it lands.
 */
class ProviderRefreshTest {
    private val executor = Executors.newSingleThreadExecutor()
    private val syncs = AtomicInteger()
    private val told = AtomicInteger()

    @After
    fun stop() {
        executor.shutdownNow()
    }

    private fun refresh(sync: () -> Boolean = { syncs.incrementAndGet(); true }, waitMs: Long = 2_000, cancelled: () -> Boolean = { false }) =
        ProviderRefresh.run({ executor.submit(it) }, sync, { told.incrementAndGet() }, waitMs, cancelled)

    @Test
    fun aRefreshSyncsThenTellsTheFolderBeforeItAnswers() {
        assertTrue(refresh())
        assertEquals(1, syncs.get())
        assertEquals("told before the answer, so Files reloads what the sync brought", 1, told.get())
    }

    @Test
    fun aRefreshDuringARunningPullSyncsAgainAfterIt() {
        val release = CountDownLatch(1)
        // A listing's pull, still waiting on the network when the person pulls down.
        executor.submit { release.await(); syncs.incrementAndGet() }
        Thread { Thread.sleep(200); release.countDown() }.start()
        assertTrue(refresh())
        assertEquals("one sync of its own, after the pull already running", 2, syncs.get())
        assertEquals(1, told.get())
    }

    @Test
    fun aSlowSyncAnswersAtTheWaitAndStillTellsTheFolderWhenItLands() {
        val release = CountDownLatch(1)
        val started = System.nanoTime()
        assertFalse(refresh(sync = { release.await(); true }, waitMs = 300))
        val waited = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("the binder waited ${waited} ms", waited in 250..1_500)
        assertEquals("not told before it ran", 0, told.get())
        release.countDown()
        executor.submit {}.get(2, TimeUnit.SECONDS)
        assertEquals("told once the slow sync landed", 1, told.get())
    }

    @Test
    fun aCancelledRefreshLetsTheBinderGoAtOnce() {
        val release = CountDownLatch(1)
        val cancelAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(150)
        val started = System.nanoTime()
        assertFalse(refresh(sync = { release.await(); true }, waitMs = 5_000, cancelled = { System.nanoTime() >= cancelAt }))
        val waited = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("the binder waited ${waited} ms after a cancel at 150 ms", waited < 1_000)
        release.countDown()
    }

    @Test
    fun aSyncThatFailsIsNotAnsweredAsRefreshed() {
        assertFalse(refresh(sync = { throw IllegalStateException("offline") }))
        assertFalse(refresh(sync = { false }))
        assertEquals("the folder is still told, so Files reloads what the phone has", 2, told.get())
    }
}
