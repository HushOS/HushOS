package com.hushos.app.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * What this account shares is asked again after every restore, at once, and after a sync that
 * applied a change in its own drive, at most once per ten seconds: the server leaves trashed
 * items out of `/shares/mine`, so a restored shared folder showed nobody on it (and By me left
 * it out) until the screen was opened again, while asking after every sync would send a request
 * per file of a large upload. A request made while a load is under way gets a load begun after
 * it, or the marks keep what the server said before the restore.
 */
class SharingRefreshTest {
    /* A clock the test moves: a wait ends when the time passes its deadline (or at `finish`). */
    private class Time {
        var now = 0L
        val waits = ArrayList<Long>()
        private val sleepers = ArrayList<Pair<Long, CompletableDeferred<Unit>>>()

        suspend fun wait(ms: Long) {
            waits.add(ms)
            // A wait that begins at or past its end (the coroutine started late) is over at once, as delay is.
            if (ms <= 0) return
            val wake = CompletableDeferred<Unit>()
            sleepers.add(now + ms to wake)
            wake.await()
        }

        suspend fun advance(to: Long) {
            now = to
            val due = sleepers.filter { it.first <= to }
            sleepers.removeAll(due)
            due.forEach { it.second.complete(Unit) }
            repeat(50) { yield() }
        }

        /* Wakes every sleeper still waiting, so no coroutine outlives the test. */
        suspend fun finish() = advance(1_000_000_000)
    }

    /* Counts loads; the first waits for `release` while `held`, so requests can arrive mid-load. */
    private class Server(private val time: Time, held: Boolean = false) {
        var loads = 0
        val events = ArrayList<String>()
        val reading = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>().also { if (!held) it.complete(Unit) }

        suspend fun load() {
            val n = ++loads
            events.add("load $n began at ${time.now}")
            reading.complete(Unit)
            release.await()
            events.add("load $n answered")
        }
    }

    private fun CoroutineScope.refresher(server: Server, time: Time) =
        SharingRefresh(this, interval = 10_000, clock = { time.now }, wait = { time.wait(it) }) { server.load() }

    @Test
    fun aRestoreRefreshesEvenWhenTheSyncBroughtNothing() = runBlocking {
        val time = Time()
        val server = Server(time)
        val refresh = refresher(server, time)
        // The restore's own change was already filed, or the feed wasn't asked: the restore still counts.
        refresh.afterSync(emptySet(), restored = true)
        refresh.afterSync(null, restored = true)
        assertEquals(2, server.loads)
    }

    @Test
    fun aSyncWithOwnChangesRefreshesOnceAndOneWithoutDoesNot() = runBlocking {
        val time = Time()
        val server = Server(time)
        val refresh = refresher(server, time)
        refresh.afterSync(setOf("lisbon", "photos", "root"), restored = false)
        assertEquals(1, server.loads)
        time.advance(30_000)
        refresh.afterSync(emptySet(), restored = false)
        refresh.afterSync(null, restored = false)
        assertEquals(1, server.loads)
        assertNull(refresh.trailing)
    }

    @Test
    fun ownChangesLoadAtMostOncePerIntervalWithOneLoadAtItsEnd() = runBlocking {
        val time = Time()
        val server = Server(time)
        val refresh = refresher(server, time)
        // An upload of many files: a sync after each one.
        refresh.afterSync(setOf("p1"), restored = false)
        for ((ms, id) in listOf(2_000L to "p2", 5_000L to "p3", 9_000L to "p4")) {
            time.advance(ms)
            refresh.afterSync(setOf(id), restored = false)
        }
        assertEquals(1, server.loads)
        // One wait, to the end of the interval the first load began.
        assertEquals(1, time.waits.size)
        time.advance(10_000)
        refresh.trailing?.join()
        assertEquals(listOf("load 1 began at 0", "load 1 answered", "load 2 began at 10000", "load 2 answered"), server.events)
        time.advance(11_000)
        refresh.afterSync(setOf("p5"), restored = false)
        assertEquals(2, server.loads)
        time.finish()
        assertEquals(3, server.loads)
    }

    @Test
    fun aRestoreIsNeverHeldAndAnswersAChangeWaitingForTheInterval() = runBlocking {
        val time = Time()
        val server = Server(time)
        val refresh = refresher(server, time)
        refresh.afterSync(setOf("p1"), restored = false)
        time.advance(2_000)
        refresh.afterSync(setOf("p2"), restored = false)
        time.advance(3_000)
        refresh.afterSync(setOf("lisbon"), restored = true)
        assertEquals(listOf("load 1 began at 0", "load 1 answered", "load 2 began at 3000", "load 2 answered"), server.events)
        // The change at 2 s was answered by the restore's load: nothing more at the interval's end.
        time.finish()
        assertEquals(2, server.loads)
    }

    @Test
    fun requestsDuringALoadGetOneLoadBegunAfterThem() = runBlocking {
        val time = Time()
        val server = Server(time, held = true)
        val refresh = refresher(server, time)
        // A live sync's refresh is reading the server when a restore lands, then a sync and a pull come in.
        val first = launch { refresh.afterSync(setOf("a"), restored = false) }
        server.reading.await()
        var restoreAnsweredAfter: String? = null
        val restore = launch {
            refresh.afterSync(setOf("lisbon"), restored = true)
            restoreAnsweredAfter = server.events.last()
        }
        val more = launch { refresh.afterSync(setOf("b"), restored = false) }
        val again = launch { refresh.now() }
        repeat(50) { yield() }
        server.release.complete(Unit)
        listOf(first, restore, more, again).forEach { it.join() }
        time.finish()
        // One more load after the one under way, not one per request, and the restore waited for it.
        assertEquals(2, server.loads)
        assertEquals(listOf("load 1 began at 0", "load 1 answered", "load 2 began at 0", "load 2 answered"), server.events)
        assertEquals("load 2 answered", restoreAnsweredAfter)
    }
}
