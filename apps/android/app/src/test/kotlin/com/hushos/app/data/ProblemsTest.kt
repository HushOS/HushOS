package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/* The alert says what happened in plain words; an exception's own text never reaches the screen. */
class ProblemsTest {
    @Test
    fun aFullDriveSaysNotEnoughRoomWhateverTheServerCallsIt() {
        assertEquals("Not enough room", Problems.of(ApiError(413, "Payload too large")).title)
        assertEquals("Not enough room", Problems.of(ApiError(400, "Storage quota exceeded")).title)
        assertEquals("Not enough room", Problems.of(ApiError(402, "Payment required")).title)
        // The transfers sheet still offers Make room for it.
        assertEquals(true, TransferQueue.isNoRoom(Problems.say(ApiError(413, "Payload too large"), "The transfer failed.")))
    }

    /* Auth's calls say no network as AuthFailure(UNREACHABLE): that is offline (the line at the top), not "That didn't work". */
    @Test
    fun noNetworkIsOfflineHoweverTheCallSaysIt() {
        assertEquals("You’re offline", Problems.of(Unreachable()).title)
        assertEquals("You’re offline", Problems.of(AuthFailure(Auth.UNREACHABLE)).title)
        assertEquals(true, Problems.offline(AuthFailure(Auth.UNREACHABLE)))
        // A refusal from the server is not being offline, and a local file error doesn't turn the offline line on.
        assertEquals(false, Problems.offline(AuthFailure("That password isn’t right. Check it and try again.")))
        assertEquals(false, Problems.offline(java.io.IOException("No space left on device")))
    }

    @Test
    fun aGoneItemAndAServerFaultEachHaveTheirOwnWords() {
        assertEquals("It’s no longer here", Problems.of(NotFound("This item no longer exists.")).title)
        assertEquals("It’s no longer here", Problems.of(ApiError(410, "gone")).title)
        assertEquals(Problems.SERVER, Problems.of(ApiError(502, "Bad gateway")).body)
    }

    /*
     * The owner's phone showed "The coroutine was canceled because it left the composition" under "That didn't work".
     * Whatever an exception says, neither the alert nor a one-line message repeats it; only the app's own sentences
     * (a refusal, a sign-in failure) are said as written.
     */
    @Test
    fun noExceptionsOwnTextIsEverShown() {
        val raw = "The coroutine was canceled because it left the composition"
        val errors = listOf(
            IllegalStateException(raw), RuntimeException(raw), org.json.JSONException(raw), java.util.concurrent.CancellationException(raw),
            ApiError(400, raw), ApiError(403, raw), ApiError(404, raw), ApiError(409, raw), ApiError(413, raw), ApiError(429, raw), ApiError(500, raw),
            NotFound(raw), java.io.IOException(raw), NullPointerException(raw),
        )
        for (error in errors) {
            val problem = Problems.of(error)
            for (field in listOf(problem.title, problem.body, Problems.say(error, "Couldn’t share. Try again."))) {
                assertFalse("${error.javaClass.simpleName} put its own text on screen: “$field”", field.contains("coroutine", ignoreCase = true))
            }
        }
        assertEquals("That didn’t work", Problems.of(IllegalStateException(raw)).title)
        assertEquals("Couldn’t share. Try again.", Problems.say(IllegalStateException(raw), "Couldn’t share. Try again."))
    }

    @Test
    fun theAppsOwnSentencesAreSaidAsWritten() {
        assertEquals("Update HushOS", Problems.of(NewerFormat()).title)
        assertEquals("That password isn’t right. Check it and try again.", Problems.say(AuthFailure("That password isn’t right. Check it and try again."), "fallback"))
    }

    @Test
    fun signInKeepsTheServersSentenceAndOtherwiseSaysWhatHappened() {
        assertEquals("This account is locked.", Problems.signIn(403, "This account is locked."))
        assertEquals("Too many tries. Wait a moment, then try again.", Problems.signIn(429, ""))
        assertEquals(Problems.SERVER, Problems.signIn(503, null))
        assertEquals("HushOS didn’t answer as expected. Try again in a moment.", Problems.signIn(400, ""))
    }
}
