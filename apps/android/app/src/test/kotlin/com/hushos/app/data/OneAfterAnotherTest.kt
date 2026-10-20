package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Vault.trashMany sends one request per item, one after another. An ordinary refusal leaves the
 * rest to go on; no network or an ended session stops it, and the items not sent are reported as
 * not moved (with that failure), never as moved and never by sending a dozen doomed requests.
 */
class OneAfterAnotherTest {
    private val ids = (1..6).map { "n$it" }

    @Test
    fun anOrdinaryRefusalDoesNotStopTheRest() {
        val sent = ArrayList<String>()
        val outcomes = oneAfterAnother(ids) { id -> sent.add(id); if (id == "n2") throw ApiError(409, "trashed") }
        assertEquals(ids, sent)
        assertEquals(listOf(true, false, true, true, true, true), outcomes.map { it.isSuccess })
    }

    @Test
    fun noNetworkStopsSendingAndTheRestAreNotMoved() {
        val sent = ArrayList<String>()
        val outcomes = oneAfterAnother(ids) { id -> sent.add(id); if (id == "n3") throw Unreachable() }
        assertEquals(listOf("n1", "n2", "n3"), sent)
        assertEquals(listOf(true, true, false, false, false, false), outcomes.map { it.isSuccess })
        assertTrue(outcomes.drop(2).all { it.exceptionOrNull() is Unreachable })
    }

    @Test
    fun anEndedSessionStopsSendingToo() {
        val sent = ArrayList<String>()
        val outcomes = oneAfterAnother(ids) { id -> sent.add(id); if (id == "n1") throw NotAuthenticated() }
        assertEquals(listOf("n1"), sent)
        assertTrue(outcomes.all { it.exceptionOrNull() is NotAuthenticated })
    }
}
