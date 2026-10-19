package com.hushos.app.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* What releases the picker after a recovery here: only a real answer from the server, and a marker that survives. */
class RecoveryWordsTest {
    @Test
    fun onlyARealAnswerSaysTheWordsAreSaved() {
        assertEquals(false, RecoveryWords.answer(Result.success(true)))
        assertEquals(true, RecoveryWords.answer(Result.success(false)))
        // No words at all on the account: nothing to wait for.
        assertEquals(false, RecoveryWords.answer(Result.failure(NoRecoveryKey())))
        // A server error, a refusal, no network: not an answer, so neither released nor cleared.
        assertNull(RecoveryWords.answer(Result.failure(AuthFailure("HushOS had a problem.", 503))))
        assertNull(RecoveryWords.answer(Result.failure(AuthFailure("Forbidden", 403))))
        assertNull(RecoveryWords.answer(Result.failure(AuthUnreachable())))
        assertNull(RecoveryWords.answer(Result.failure(NotAuthenticated())))
    }

    /* The app stopped with the new words on screen: a new process reads the same marker. */
    @Test
    fun theMarkerOutlivesTheProcess() {
        val file = File(Files.createTempDirectory("words").toFile(), RecoveryMarker.FILE)
        RecoveryMarker(file).set(true)
        assertTrue(RecoveryMarker(file).get())
        RecoveryMarker(file).set(false)
        assertFalse(RecoveryMarker(file).get())
    }
}
