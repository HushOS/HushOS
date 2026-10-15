package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/*
 * The Files app asks for whom this person trusts from many threads at once. A load per request multiplied the loads,
 * and with only the latest kept, none landed while browsing went on: every row stayed "Couldn't check". One load is
 * shared; one begun before the vault was dropped (or the keys changed) is never kept, and never joined by the next.
 */
class SharedLoadTest {
    /* What the provider keeps, for the vault it holds now (`reset`, as requireVault does). */
    private class Provider(vault: String) {
        @Volatile var kept: String? = null
        val keeps = AtomicInteger()
        val loads = SharedLoad<String, String>().also { it.reset(vault) }

        fun ask(vault: String, read: () -> String): String =
            loads.load(vault, read) { result -> kept = result; keeps.incrementAndGet() }

        /* requireVault for another session: the old vault goes, nothing begun for it lands, the new one comes. */
        fun replace(next: String) = loads.reset(next) { kept = null }
    }

    /* A read that counts its calls; the first is held, already read, until `release`. */
    private class Reads(private val first: String, private val later: String = first) {
        val calls = AtomicInteger()
        val reading = CountDownLatch(1)
        val release = CountDownLatch(1)

        fun read(): String {
            if (calls.incrementAndGet() > 1) return later
            reading.countDown()
            release.await(10, TimeUnit.SECONDS)
            return first
        }
    }

    /* Until every thread is parked (waiting on the shared load) or done. */
    private fun settled(threads: List<Thread>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (threads.any { it.state != Thread.State.WAITING && it.state != Thread.State.TERMINATED }) {
            check(System.nanoTime() < deadline) { "requests never settled" }
            Thread.sleep(5)
        }
    }

    @Test
    fun requestsWhileALoadRunsShareIt() {
        val alice = "vault-a"
        val provider = Provider(alice)
        val reads = Reads("keys")
        val answers = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val first = thread { answers.add(provider.ask(alice, reads::read)) }
        assertTrue(reads.reading.await(10, TimeUnit.SECONDS))
        val others = (1..5).map { thread { answers.add(provider.ask(alice, reads::read)) } }
        settled(others)
        reads.release.countDown()
        (others + first).forEach { it.join(10_000) }
        assertEquals("one load for six requests", 1, reads.calls.get())
        assertEquals(List(6) { "keys" }, answers.toList())
        assertEquals("keys", provider.kept)
        assertEquals(1, provider.keeps.get())
    }

    @Test
    fun aLoadBegunBeforeAnInvalidationIsNotKeptAndTheNextOneIs() {
        val alice = "vault-a"
        val provider = Provider(alice)
        val reads = Reads(first = "old key", later = "new key")
        var older: String? = null
        val first = thread { older = provider.ask(alice, reads::read) }
        assertTrue(reads.reading.await(10, TimeUnit.SECONDS))
        // A succession or a pin change: what the load under way read is from before it.
        provider.loads.invalidate()
        // The next request doesn't join it: it loads afresh, and that is kept.
        assertEquals("new key", provider.ask(alice, reads::read))
        reads.release.countDown()
        first.join(10_000)
        // The older request is answered with what it read (it asked before the change), and nothing of it is kept.
        assertEquals("old key", older)
        assertEquals("new key", provider.kept)
        assertEquals(2, reads.calls.get())
    }

    @Test
    fun aLoadForAVaultDroppedMeanwhileIsNeitherKeptNorJoined() {
        val alice = "vault-a"
        val bob = "vault-b"
        val provider = Provider(alice)
        // Alice's request took her vault, then another session replaced it before her load began.
        provider.replace(bob)
        val reads = Reads(first = "alice's keys", later = "bob's keys")
        val late = thread { provider.ask(alice, reads::read) }
        assertTrue(reads.reading.await(10, TimeUnit.SECONDS))
        // Bob's requests don't join the load for Alice's vault: his own is read, and kept.
        assertEquals("bob's keys", provider.ask(bob, reads::read))
        reads.release.countDown()
        late.join(10_000)
        assertEquals("bob's keys", provider.kept)
        assertEquals(1, provider.keeps.get())

        // And one already under way when the vault is replaced lands for neither.
        val again = Provider(alice)
        val held = Reads("alice's keys")
        val running = thread { again.ask(alice, held::read) }
        assertTrue(held.reading.await(10, TimeUnit.SECONDS))
        again.replace(bob)
        held.release.countDown()
        running.join(10_000)
        assertEquals(null, again.kept)
    }

    @Test
    fun aRequestStillHoldingADroppedVaultDoesNotKeepTheCurrentOnesFromSharing() {
        val alice = "vault-a"
        val bob = "vault-b"
        val provider = Provider(alice)
        provider.replace(bob)
        val reads = Reads("bob's keys")
        val first = thread { provider.ask(bob, reads::read) }
        assertTrue(reads.reading.await(10, TimeUnit.SECONDS))
        // A request that took Alice's vault before it was dropped loads now, for itself.
        assertEquals("alice's keys", provider.ask(alice) { "alice's keys" })
        // Bob's next request still joins his load under way.
        val second = thread { provider.ask(bob, reads::read) }
        settled(listOf(second))
        reads.release.countDown()
        listOf(first, second).forEach { it.join(10_000) }
        assertEquals("one load for Bob's two requests", 1, reads.calls.get())
        assertEquals("bob's keys", provider.kept)
    }

    @Test
    fun theyWhoJoinedGetTheResultEvenWhenKeepingItFails() {
        val loads = SharedLoad<String, String>().also { it.reset("vault-a") }
        val reads = Reads("keys")
        var failed: Throwable? = null
        val first = thread(isDaemon = true) {
            failed = runCatching { loads.load("vault-a", reads::read) { throw IllegalStateException("keeping failed") } }.exceptionOrNull()
        }
        assertTrue(reads.reading.await(10, TimeUnit.SECONDS))
        var joined: String? = null
        val other = thread(isDaemon = true) { joined = loads.load("vault-a", reads::read) {} }
        settled(listOf(other))
        reads.release.countDown()
        first.join(10_000)
        other.join(5_000)
        assertTrue("the joined request must not wait forever", !other.isAlive)
        assertEquals("keys", joined)
        assertTrue(failed is IllegalStateException)
        assertEquals(1, reads.calls.get())
    }
}
