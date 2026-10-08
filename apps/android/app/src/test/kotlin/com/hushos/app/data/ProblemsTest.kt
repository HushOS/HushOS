package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/* The alert says what happened in plain words; the server's raw text only ever sits behind Details. */
class ProblemsTest {
    @Test
    fun aFullDriveSaysNotEnoughRoomWhateverTheServerCallsIt() {
        assertEquals("Not enough room", Problems.of(ApiError(413, "Payload too large")).title)
        assertEquals("Not enough room", Problems.of(ApiError(400, "Storage quota exceeded")).title)
        assertEquals("Storage quota exceeded", Problems.of(ApiError(400, "Storage quota exceeded")).detail)
    }

    @Test
    fun noNetworkIsOfflineWithNoRawDetail() {
        val problem = Problems.of(Unreachable())
        assertEquals("You’re offline", problem.title)
        assertNull(problem.detail)
    }

    @Test
    fun aGoneItemAndAServerFaultEachHaveTheirOwnWords() {
        assertEquals("It’s no longer here", Problems.of(NotFound("This item no longer exists.")).title)
        assertEquals("It’s no longer here", Problems.of(ApiError(410, "gone")).title)
        assertEquals(Problems.SERVER, Problems.of(ApiError(502, "Bad gateway")).body)
    }

    @Test
    fun anythingElseIsPlainWithTheRawTextOnlyAsDetail() {
        val problem = Problems.of(IllegalStateException("chunk 3 failed authentication"))
        assertEquals("That didn’t work", problem.title)
        assertEquals("chunk 3 failed authentication", problem.detail)
    }

    @Test
    fun signInKeepsTheServersSentenceAndOtherwiseSaysWhatHappened() {
        assertEquals("This account is locked.", Problems.signIn(403, "This account is locked."))
        assertEquals("Too many tries. Wait a moment, then try again.", Problems.signIn(429, ""))
        assertEquals(Problems.SERVER, Problems.signIn(503, null))
        assertEquals("HushOS didn’t answer as expected. Try again in a moment.", Problems.signIn(400, ""))
    }
}
