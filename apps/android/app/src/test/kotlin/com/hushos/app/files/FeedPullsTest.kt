package com.hushos.app.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The provider's feed pulls, with the executor and the pull in the test's hands. A listing asked for while a pull runs
 * was answered before that pull filed anything: it must be told again after a pull that began later, and only once the
 * run has ended, or its next listing queues behind the same run and is told forever.
 */
class FeedPullsTest {
    private val queued = ArrayList<Runnable>()
    private var pulls = 0
    private var onPull: () -> Unit = {}
    private val told = ArrayList<Set<String>>()
    private lateinit var feed: FeedPulls

    private fun feed() = FeedPulls(execute = { queued.add(it) }, pull = { pulls++; onPull() }, tell = { told.add(it) }).also { feed = it }

    private fun runQueued() { while (queued.isNotEmpty()) queued.removeAt(0).run() }

    @Test
    fun aListingAskedForMidPullIsPulledForAgainThenTold() {
        feed()
        feed.request("folder-a")
        // Files lists two folders while the first pull runs; both are kept, not dropped.
        onPull = { if (pulls == 1) { feed.request("folder-b"); feed.request("root") } }
        runQueued()
        assertEquals("one more pull, begun after those listings", 2, pulls)
        assertEquals(listOf(setOf("folder-b", "root")), told)
    }

    @Test
    fun aListingAloneIsToldOnlyByWhatItsPullChanged() {
        feed()
        feed.request("folder-a")
        runQueued()
        assertEquals(1, pulls)
        assertEquals("the pull tells its own folders (Vault.sync); nothing more", emptyList<Set<String>>(), told)
    }

    @Test
    fun theListingATellCausesStartsAPullOfItsOwnAndTheRunEnds() {
        feed()
        // Files answers every tell by listing the folder again at once, as it does.
        val relist = FeedPulls(execute = { queued.add(it) }, pull = { pulls++; onPull() }, tell = { folders -> told.add(folders); folders.forEach { feed.request(it) } })
        feed = relist
        feed.request("folder-a")
        onPull = { if (pulls == 1) feed.request("folder-b") }
        runQueued()
        // folder-b: pulled for again and told; its listing then starts a run of its own, which tells nothing.
        assertEquals(3, pulls)
        assertEquals(listOf(setOf("folder-b")), told)
        assertTrue(queued.isEmpty())
    }

    @Test
    fun aPullThatFailsStillEndsTheRun() {
        feed()
        onPull = { throw IllegalStateException("offline") }
        feed.request("folder-a")
        runQueued()
        feed.request("folder-b")
        runQueued()
        assertEquals("the next listing still pulls", 2, pulls)
    }
}
