package com.hushos.app.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * What this account shares is asked again after every restore and after a sync that applied a
 * change in its own drive, once per sync: the server leaves trashed items out of `/shares/mine`,
 * so a restored shared folder showed nobody on it (and By me left it out) until the screen was
 * opened again. A request made while a load is under way gets a load begun after it, or the
 * marks keep what the server said before the restore.
 */
class SharingRefreshTest {
    /* Counts loads; the first waits for `release` while `held`, so requests can arrive mid-load. */
    private class Server(held: Boolean = false) {
        var loads = 0
        val events = ArrayList<String>()
        val reading = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>().also { if (!held) it.complete(Unit) }

        suspend fun load() {
            val n = ++loads
            events.add("load $n began")
            reading.complete(Unit)
            release.await()
            events.add("load $n answered")
        }
    }

    @Test
    fun aRestoreRefreshesEvenWhenTheSyncBroughtNothing() = runBlocking {
        val server = Server()
        val refresh = SharingRefresh { server.load() }
        // The restore's own change was already filed, or the feed wasn't asked: the restore still counts.
        refresh.afterSync(emptySet(), restored = true, inUse = false)
        refresh.afterSync(null, restored = true, inUse = false)
        assertEquals(2, server.loads)
    }

    @Test
    fun aSyncWithOwnChangesRefreshesOnceAndOneWithoutDoesNot() = runBlocking {
        val server = Server()
        val refresh = SharingRefresh { server.load() }
        refresh.afterSync(setOf("lisbon", "photos", "root"), restored = false, inUse = true)
        assertEquals(1, server.loads)
        refresh.afterSync(emptySet(), restored = false, inUse = true)
        refresh.afterSync(null, restored = false, inUse = true)
        assertEquals(1, server.loads)
    }

    @Test
    fun nothingIsAskedWhileNoScreenHasAskedForIt() = runBlocking {
        val server = Server()
        val refresh = SharingRefresh { server.load() }
        refresh.afterSync(setOf("lisbon"), restored = false, inUse = false)
        assertEquals(0, server.loads)
    }

    @Test
    fun requestsDuringALoadGetOneLoadBegunAfterThem() = runBlocking {
        val server = Server(held = true)
        val refresh = SharingRefresh { server.load() }
        // A live sync's refresh is reading the server when a restore lands, then two more syncs come in.
        val first = launch { refresh.afterSync(setOf("a"), restored = false, inUse = true) }
        server.reading.await()
        var restoreAnsweredAfter: String? = null
        val restore = launch {
            refresh.afterSync(setOf("lisbon"), restored = true, inUse = true)
            restoreAnsweredAfter = server.events.last()
        }
        val more = launch { refresh.afterSync(setOf("b"), restored = false, inUse = true) }
        val again = launch { refresh.now() }
        repeat(50) { yield() }
        server.release.complete(Unit)
        listOf(first, restore, more, again).forEach { it.join() }
        // One more load after the one under way, not one per request, and the restore waited for it.
        assertEquals(2, server.loads)
        assertEquals(listOf("load 1 began", "load 1 answered", "load 2 began", "load 2 answered"), server.events)
        assertEquals("load 2 answered", restoreAnsweredAfter)
    }
}
