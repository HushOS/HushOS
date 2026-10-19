package com.hushos.app.data

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* What a recovery on this phone holds, for whom, and what releases it. */
class RecoveryWordsTest {
    private val dir = Files.createTempDirectory("words").toFile()
    private val file = File(dir, RecoveryMarker.FILE)

    @After fun reset() = RecoveryWords.settled()

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

    /* The app stopped with the new words on screen: a new process reads the same marker, for the same account. */
    @Test
    fun theMarkerOutlivesTheProcessForItsAccount() {
        RecoveryWords.use(RecoveryMarker(file))
        RecoveryWords.begun("alice")
        RecoveryWords.use(RecoveryMarker(file))
        assertEquals("alice", RecoveryWords.waitingFor.value)
        assertTrue(RecoveryWords.waitingFor("alice"))
    }

    /* Someone else signed in on the phone afterwards is not held, and the stale marker goes. */
    @Test
    fun aDifferentAccountIsNotHeldAndTheMarkerIsCleared() {
        RecoveryWords.use(RecoveryMarker(file))
        RecoveryWords.begun("alice")
        assertFalse(RecoveryWords.waitingFor("bob"))
        assertNull(RecoveryMarker(file).owner())
        assertFalse(RecoveryWords.waitingFor("alice"))
    }

    /* Sign-out wipes the account; another account claiming the phone keeps only its own marker. */
    @Test
    fun signOutAndAnotherAccountClearItTheSameAccountKeepsIt() {
        RecoveryWords.use(RecoveryMarker(file))
        val store = AccountStore(File(dir, "files"), File(dir, "cache"))
        store.claim("alice")
        RecoveryWords.begun("alice")
        store.claim("alice")
        assertEquals("alice", RecoveryMarker(file).owner())
        store.claim("bob")
        assertNull(RecoveryMarker(file).owner())
        RecoveryWords.begun("bob")
        store.wipe()
        assertNull(RecoveryMarker(file).owner())
    }
}
