package com.hushos.app.ui

import com.hushos.app.ui.PickerReturn.Words
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The picker's sign-in screen goes back to the picker once the account is open on this phone, wherever it was opened,
 * and never while the account's recovery words wait to be confirmed as saved. Each case is a journey the person can
 * take, with the picker's screen asking again as it resumes.
 */
class PickerReturnTest {
    private fun resumes(signedIn: Boolean, server: Boolean?, localUnsaved: Boolean = false) =
        PickerReturn.ready(if (signedIn) Gate.SIGNED_IN else Gate.SIGNED_OUT, recovery = null, words = PickerReturn.words(server), localUnsaved = localUnsaved)

    /* The first dead end: a sign-in done in the app's own screen never let the picker's screen go back. */
    @Test
    fun aSignInInTheAppReturnsOnTheNextResume() {
        assertFalse(resumes(signedIn = false, server = null))
        assertTrue(resumes(signedIn = true, server = false))
    }

    /* A recovery finished in the app: back only once its words are confirmed, and the server says when. */
    @Test
    fun aRecoveryReturnsOnlyOnceTheServerHasTheWordsConfirmed() {
        assertFalse(resumes(signedIn = true, server = true, localUnsaved = true))
        assertTrue(PickerReturn.holding(Gate.SIGNED_IN, PickerReturn.words(true), localUnsaved = true))
        assertTrue(resumes(signedIn = true, server = false, localUnsaved = false))
    }

    /* The app stopped while the new words were on screen: the in-memory flag is gone, the server's answer is not. */
    @Test
    fun wordsLeftUnconfirmedWhenTheAppWasStoppedStillHold() {
        assertFalse(resumes(signedIn = true, server = true, localUnsaved = false))
        assertTrue(PickerReturn.holding(Gate.SIGNED_IN, PickerReturn.words(true), localUnsaved = false))
    }

    /* A recovery cancelled after it began left the flag set with nothing to show: the server's "saved" wins. */
    @Test
    fun aStaleFlagWithNothingToSaveDoesNotHold() {
        assertTrue(resumes(signedIn = true, server = false, localUnsaved = true))
        assertFalse(PickerReturn.holding(Gate.SIGNED_IN, PickerReturn.words(false), localUnsaved = true))
    }

    /* The server can't be asked: only then does a recovery in this process decide. */
    @Test
    fun withoutTheServerTheLocalFlagDecides() {
        assertFalse(resumes(signedIn = true, server = null, localUnsaved = true))
        assertTrue(resumes(signedIn = true, server = null, localUnsaved = false))
    }

    @Test
    fun nothingReturnsWhileCheckingOrDuringItsOwnRecovery() {
        assertFalse(PickerReturn.ready(Gate.SIGNED_IN, null, Words.CHECKING, localUnsaved = false))
        assertFalse(PickerReturn.holding(Gate.SIGNED_IN, Words.CHECKING, localUnsaved = false))
        assertFalse(PickerReturn.ready(Gate.CHECKING, null, Words.SAVED, localUnsaved = false))
        for (step in DriveViewModel.RecoveryStep.entries) assertFalse("left during $step", PickerReturn.ready(Gate.SIGNED_IN, step, Words.SAVED, localUnsaved = false))
    }
}
