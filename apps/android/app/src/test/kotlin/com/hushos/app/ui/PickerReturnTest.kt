package com.hushos.app.ui

import com.hushos.app.data.RecoveryWords
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The picker's sign-in screen goes back to the picker once the account is open on this phone, wherever it was opened,
 * and never while a recovery's new words wait to be confirmed. The first version had two dead ends: a recovery (which
 * always finishes in the app's own screen, through its emailed link) or a sign-in in the app left the picker's screen
 * waiting forever on its own view model. These play those journeys out against the process-wide RecoveryWords the
 * app's screen sets, with the picker's own view model never signing in itself.
 */
class PickerReturnTest {
    @After fun reset() = RecoveryWords.settled()

    /* The picker's view model after it looked at the session again on resume (DriveViewModel.resumed). */
    private fun pickerResumes(sessionOnPhone: Boolean) =
        PickerReturn.ready(if (sessionOnPhone) Gate.SIGNED_IN else Gate.SIGNED_OUT, recovery = null, wordsUnsaved = RecoveryWords.unsaved.value)

    @Test
    fun aRecoveryFinishedInTheAppReturnsOnlyAfterItsNewWordsAreConfirmed() {
        assertFalse("signed out: stays", pickerResumes(sessionOnPhone = false))
        // In the app's own screen: the kit is checked, then the session is stored before the new words show.
        RecoveryWords.begun()
        assertFalse("new words not seen yet: stays", pickerResumes(sessionOnPhone = true))
        // The words are shown and confirmed (leaveRecovery).
        RecoveryWords.settled()
        assertTrue("account open, words saved: back to the picker", pickerResumes(sessionOnPhone = true))
    }

    @Test
    fun aFailedRecoveryLeavesNothingWaiting() {
        RecoveryWords.begun()
        RecoveryWords.settled()
        assertFalse(pickerResumes(sessionOnPhone = false))
        // Then a plain sign-in in the app's own screen: the picker's screen goes back on its next resume.
        assertTrue(pickerResumes(sessionOnPhone = true))
    }

    @Test
    fun theGateStaysWhileChecking() {
        assertFalse(PickerReturn.ready(Gate.CHECKING, null, wordsUnsaved = false))
        for (step in DriveViewModel.RecoveryStep.entries) assertFalse("left during $step", PickerReturn.ready(Gate.SIGNED_IN, step, wordsUnsaved = false))
    }
}
