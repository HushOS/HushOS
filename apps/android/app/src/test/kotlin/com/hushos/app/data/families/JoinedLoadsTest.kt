package com.hushos.app.data.families

import com.hushos.app.data.trust.JoinedLoads
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/*
 * The view model's launch-time trust loads (JoinedLoads): a second ask joins a load under way for the same vault and
 * generation; a joined load that failed is loaded once more, but never for a vault the session moved away from while
 * it waited (that load would supersede the new account's); and no vault is held once its load is done or the session
 * ends, so a signed-out account's keys are never kept reachable from the view model.
 */
class JoinedLoadsTest {
    private class Vault(val name: String)

    /* A load that waits until it is told how it went, counting how many were started for each vault. */
    private class Loads {
        val started = HashMap<String, Int>()
        val answers = ArrayList<CompletableDeferred<Boolean>>()
        fun start(vault: Vault): suspend () -> Boolean = {
            started[vault.name] = (started[vault.name] ?: 0) + 1
            val answer = CompletableDeferred<Boolean>()
            answers.add(answer)
            answer.await()
        }
    }

    private suspend fun settle() = repeat(5) { yield() }

    @Test
    fun aJoinedLoadThatSettledAnswersTheSecondAsk() = runBlocking {
        val joins = JoinedLoads<Vault>()
        val loads = Loads()
        val a = Vault("a")
        coroutineScope {
            val first = async { joins.load(this@runBlocking, a, 1, join = true, current = { a }, start = loads.start(a)) }
            settle()
            val second = async { joins.load(this@runBlocking, a, 1, join = true, current = { a }, start = loads.start(a)) }
            settle()
            loads.answers.first().complete(true)
            settle()
            val started = loads.started["a"]
            loads.answers.forEach { it.complete(true) }
            first.await(); second.await()
            assertEquals(1, started)
        }
    }

    @Test
    fun aJoinedLoadThatFailedIsLoadedOnceMoreForTheSameSession() = runBlocking {
        val joins = JoinedLoads<Vault>()
        val loads = Loads()
        val a = Vault("a")
        coroutineScope {
            val first = async { joins.load(this@runBlocking, a, 1, join = true, current = { a }, start = loads.start(a)) }
            settle()
            val second = async { joins.load(this@runBlocking, a, 1, join = true, current = { a }, start = loads.start(a)) }
            settle()
            loads.answers[0].complete(false)
            settle()
            val started = loads.started["a"]
            loads.answers.forEach { it.complete(true) }
            first.await(); second.await()
            assertEquals(2, started)
        }
    }

    /*
     * Codex: another account signs in while the ask waits on the old vault's load, which then fails. Nothing is loaded
     * for the old vault: its load would begin a newer ticket than the new account's and leave that one never landing.
     */
    @Test
    fun aSessionChangeWhileJoinedNeverLoadsForTheOldVault() = runBlocking {
        val joins = JoinedLoads<Vault>()
        val loads = Loads()
        val a = Vault("a")
        val b = Vault("b")
        var current: Vault = a
        coroutineScope {
            val first = async { joins.load(this@runBlocking, a, 1, join = true, current = { current }, start = loads.start(a)) }
            settle()
            val joined = async { joins.load(this@runBlocking, a, 1, join = true, current = { current }, start = loads.start(a)) }
            settle()
            current = b
            joins.clear()
            loads.answers.single().complete(false)
            first.await()
            settle()
            val started = loads.started["a"]
            // Any load wrongly started is let finish, so the test ends either way.
            loads.answers.forEach { it.complete(true) }
            joined.await()
            assertEquals(1, started)
        }
    }

    /* A finished load holds no vault; nor does a running one once the session ends. */
    @Test
    fun noVaultIsHeldOnceItsLoadIsDoneOrTheSessionEnds() = runBlocking {
        val joins = JoinedLoads<Vault>()
        val loads = Loads()
        val a = Vault("a")
        coroutineScope {
            val done = async { joins.load(this@runBlocking, a, 1, join = false, current = { a }, start = loads.start(a)) }
            settle()
            assertSame(a, joins.holding)
            loads.answers.single().complete(true)
            done.await()
        }
        assertNull(joins.holding)
        coroutineScope {
            val running = async { joins.load(this@runBlocking, a, 1, join = false, current = { a }, start = loads.start(a)) }
            settle()
            joins.clear()
            assertNull(joins.holding)
            loads.answers.last().complete(true)
            running.await()
        }
    }
}
