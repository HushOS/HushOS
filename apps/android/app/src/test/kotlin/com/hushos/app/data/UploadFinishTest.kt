package com.hushos.app.data

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * Quota: an upload's reserved bytes stay taken until it is completed, aborted or expires. A complete the server
 * refused must be aborted so the room comes back at once (a 1.2 GB upload left open refused the next upload as out
 * of room); a complete whose outcome is unknown may have landed and must never be aborted blind.
 */
class UploadFinishTest {
    private class Server(vararg answers: Any) {
        private val queue = ArrayDeque(answers.toList())
        var completes = 0
        var aborts = 0
        val waits = ArrayList<Long>()

        fun complete(): String {
            completes++
            return when (val next = queue.removeFirst()) {
                is Exception -> throw next
                else -> next as String
            }
        }

        fun finish() = UploadFinish.complete({ complete() }, { aborts++ }, sleep = { waits.add(it) })
    }

    private fun failsWith(server: Server): Exception {
        try { server.finish() } catch (error: Exception) { return error }
        fail("the complete should have failed"); throw IllegalStateException()
    }

    @Test
    fun aRefusedCompleteIsAbortedSoItsRoomComesBack() {
        val refusal = ApiError(400, "Every part must be listed exactly once.")
        val server = Server(refusal)
        assertSame(refusal, failsWith(server))
        assertEquals(1, server.aborts)
        assertEquals(1, server.completes)
    }

    @Test
    fun aDroppedConnectionAsksAgainAndTheFinishedUploadIsKept() {
        // The first complete landed but its answer was lost; asked again, the server returns the finished node.
        val server = Server(Unreachable(), "node")
        assertEquals("node", server.finish())
        assertEquals(0, server.aborts)
        assertEquals(2, server.completes)
    }

    @Test
    fun anOutcomeThatStaysUnknownIsLeftToExpireNotAborted() {
        val server = Server(Unreachable(), IOException("reset"), ApiError(502, "Bad gateway"), ApiError(504, "Gateway timeout"))
        assertTrue(UploadFinish.unknown(failsWith(server)))
        assertEquals(0, server.aborts)
        assertEquals(UploadFinish.ATTEMPTS, server.completes)
        assertEquals(listOf(1_000L, 2_000L, 4_000L), server.waits)
    }

    /*
     * A conflict (the file changed while it uploaded, say after a key replacement) keeps the bytes reserved "for attach
     * or abort", and Android never attaches: unaborted, the retry was refused as out of room for a day.
     */
    @Test
    fun aConflictedUploadIsAbortedSoTheRetryHasRoom() {
        val server = Server(ApiError(409, "This file changed while it was uploading."))
        failsWith(server)
        assertEquals(1, server.aborts)
        assertEquals(1, server.completes)
    }

    @Test
    fun aTimeoutOrTooManyRequestsIsNeverTakenAsDefinite() {
        for (answer in listOf(ApiError(408, "Request timeout"), ApiError(429, "Too many requests"), ApiError(500, "Internal"))) {
            val server = Server(answer, "node")
            assertEquals("node", server.finish())
            assertEquals("aborted after ${answer.status}", 0, server.aborts)
        }
    }
}
