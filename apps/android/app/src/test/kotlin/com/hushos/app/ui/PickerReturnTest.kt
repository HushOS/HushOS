package com.hushos.app.ui

import com.hushos.app.ui.PickerReturn.Words
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The picker's sign-in screen goes back to the picker once the account is open on this phone, wherever it was opened.
 * After a recovery on this phone it waits until the new words are confirmed; nothing else holds it. Each case is a
 * journey the person can take, with the picker's screen asking again as it resumes.
 */
class PickerReturnTest {
    private fun resumes(signedIn: Boolean, server: Boolean?, recoveredHere: Boolean = false) =
        PickerReturn.ready(if (signedIn) Gate.SIGNED_IN else Gate.SIGNED_OUT, recovery = null, words = PickerReturn.words(server), localUnsaved = recoveredHere)

    private fun held(server: Boolean?, recoveredHere: Boolean) = PickerReturn.holding(Gate.SIGNED_IN, PickerReturn.words(server), recoveredHere)

    /* A sign-in done in the app's own screen never let the picker's screen go back. */
    @Test
    fun aSignInInTheAppReturnsOnTheNextResume() {
        assertFalse(resumes(signedIn = false, server = null))
        assertTrue(resumes(signedIn = true, server = false))
    }

    /* This phone's recovery: back only once the server has its words confirmed. */
    @Test
    fun aRecoveryHereReturnsOnlyOnceItsWordsAreConfirmed() {
        assertFalse(resumes(signedIn = true, server = true, recoveredHere = true))
        assertTrue(held(server = true, recoveredHere = true))
        assertTrue(resumes(signedIn = true, server = false, recoveredHere = true))
    }

    /* The app stopped with the words on screen: the marker is on disk, so the hold is still there. */
    @Test
    fun aRecoveryInterruptedByTheAppStoppingStillHolds() {
        assertFalse(resumes(signedIn = true, server = true, recoveredHere = true))
    }

    /* A server error or no network is not an answer: it never releases this phone's recovery. */
    @Test
    fun noAnswerKeepsHoldingARecoveryHere() {
        assertFalse(resumes(signedIn = true, server = null, recoveredHere = true))
        assertTrue(held(server = null, recoveredHere = true))
    }

    /*
     * A new account, or one whose keys were replaced, has its words unconfirmed too; it didn't recover here, so the
     * picker isn't the place to stop it.
     */
    @Test
    fun anAccountThatNeverConfirmedButDidNotRecoverHereIsNotHeld() {
        assertTrue(resumes(signedIn = true, server = true, recoveredHere = false))
        assertFalse(held(server = true, recoveredHere = false))
    }

    @Test
    fun nothingReturnsWhileCheckingARecoveryOrDuringItsOwnRecovery() {
        assertFalse(PickerReturn.ready(Gate.SIGNED_IN, null, Words.CHECKING, localUnsaved = true))
        assertFalse(PickerReturn.holding(Gate.SIGNED_IN, Words.CHECKING, localUnsaved = true))
        assertFalse(PickerReturn.ready(Gate.CHECKING, null, Words.SAVED, localUnsaved = false))
        for (step in DriveViewModel.RecoveryStep.entries) assertFalse("left during $step", PickerReturn.ready(Gate.SIGNED_IN, step, Words.SAVED, localUnsaved = false))
    }
}
