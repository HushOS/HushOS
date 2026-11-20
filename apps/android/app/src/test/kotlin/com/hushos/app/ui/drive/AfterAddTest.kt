package com.hushos.app.ui.drive

import com.hushos.app.data.trust.AccountChange
import com.hushos.app.data.trust.Added
import com.hushos.app.data.trust.ContactPin
import com.hushos.app.ui.sharing.AfterAdd
import com.hushos.app.ui.sharing.ContactStep
import com.hushos.app.ui.sharing.afterAdd
import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * Where Add someone goes next (docs/optional-verification.md 6.2, 6.12): a plain Add finishes with no words step; from a
 * mark (Check who wrote this) the words come next, for someone just added and for someone already in Contacts alike, or
 * the mark's way out would stop at a hint and never reach the check it offered.
 */
class AfterAddTest {
    private val pin = ContactPin("grace-id", "grace@example.org", "Grace Hopper", "e", "s", "", "2026-10-01T00:00:00Z", null, null)
    private val check = AfterAdd.Next(ContactStep.Check("grace@example.org", "Grace Hopper"))

    @Test
    fun aPlainAddFinishesWithNoWordsAndSaysWhenTheyAreAlreadyThere() {
        assertEquals(AfterAdd.Done, afterAdd(Added.New(pin), writer = null))
        assertEquals(AfterAdd.Hint("Grace is already in your contacts."), afterAdd(Added.Already(pin), writer = null))
    }

    @Test
    fun fromAMarkTheWordsComeNextWhetherTheyWereJustAddedOrAlreadyThere() {
        assertEquals(check, afterAdd(Added.New(pin), writer = "grace-id"))
        assertEquals(check, afterAdd(Added.Already(pin), writer = "grace-id"))
    }

    @Test
    fun anAccountThatChangedIsTheNoticeEitherWay() {
        val change = AccountChange("grace-id", "Grace Hopper", "grace@example.org")
        for (writer in listOf(null, "grace-id")) assertEquals(AfterAdd.Next(ContactStep.Changed(change)), afterAdd(Added.Changed(change), writer))
    }
}
