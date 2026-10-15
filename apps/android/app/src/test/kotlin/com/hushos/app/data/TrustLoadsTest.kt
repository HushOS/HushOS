package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/*
 * Trust loads overlap: the list's refresh is still loading when a succession (or a pin change) starts the next one, and
 * the older load can finish last. Only the latest may be kept, or the screens and the Files app check every record
 * against the replaced key or the old pins until the next load.
 */
class TrustLoadsTest {
    /* Whom this person trusts as the screens hold it: what the last landed load kept. */
    private class Held {
        @Volatile var kept: String? = null
    }

    /* One load as the view model and the provider run it: a ticket, the load itself, then landing what it read. */
    private fun load(loads: TrustLoads, held: Held, read: () -> String): String? {
        val ticket = loads.begin()
        val result = read()
        return loads.land(ticket) { result.also { held.kept = it } }
    }

    @Test
    fun aLoadThatFinishesAfterALaterOneDoesNotPutItsResultBack() {
        val loads = TrustLoads()
        val held = Held()
        val reading = CountDownLatch(1)
        val release = CountDownLatch(1)
        var older: String? = "not run"
        // Begun first, read before the succession, held until the later load has landed.
        val first = thread {
            older = load(loads, held) {
                reading.countDown()
                release.await(10, TimeUnit.SECONDS)
                "old key"
            }
        }
        assertTrue(reading.await(10, TimeUnit.SECONDS))
        assertEquals("new key", load(loads, held) { "new key" })
        release.countDown()
        first.join(10_000)
        assertNull("the older load must not land", older)
        assertEquals("new key", held.kept)
    }

    @Test
    fun loadsOneAfterAnotherEachLand() {
        val loads = TrustLoads()
        val held = Held()
        assertEquals("first", load(loads, held) { "first" })
        assertEquals("second", load(loads, held) { "second" })
        assertEquals("second", held.kept)
    }

    @Test
    fun aLoadUnderWayWhenTheAccountChangesNeverLands() {
        val loads = TrustLoads()
        val held = Held()
        // Signed out (or another account in) while the last account's load was reading.
        val landed = load(loads, held) { loads.dropAll(); "the last account's keys" }
        assertNull(landed)
        assertNull(held.kept)
        assertEquals("this account's keys", load(loads, held) { "this account's keys" })
    }
}
