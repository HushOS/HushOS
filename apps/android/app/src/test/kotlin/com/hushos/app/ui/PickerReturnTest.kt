package com.hushos.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Sign-in started from a file picker goes back to the picker once the account is open, and not a moment earlier:
 * going back while the gate is still checking, signed out, or showing a recovery's new twelve words would drop the
 * person in the picker signed out, or lose the only showing of their new words.
 */
class PickerReturnTest {
    @Test
    fun goesBackOnlyOnceTheAccountIsOpen() {
        assertTrue(PickerReturn.ready(Gate.SIGNED_IN, null))
        assertFalse(PickerReturn.ready(Gate.CHECKING, null))
        assertFalse(PickerReturn.ready(Gate.SIGNED_OUT, null))
    }

    @Test
    fun aRecoveryStaysUntilItsNewWordsAreSaved() {
        for (step in DriveViewModel.RecoveryStep.entries) {
            assertFalse("left during $step", PickerReturn.ready(Gate.SIGNED_IN, step))
            assertFalse("left during $step", PickerReturn.ready(Gate.SIGNED_OUT, step))
        }
    }
}
