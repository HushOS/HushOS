package com.hushos.app.ui

import com.hushos.app.data.MemberStanding
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Which check of a member opens, from their row or from Check it's {first} first (one rule for both): their own twelve
 * words when their account changed, or after a family check over keys that changed since; else the family check. Fails
 * if someone whose account changed is offered the family check, whose words would match the old keys.
 */
class PersonalCheckTest {
    private val grace = "6f9619ff-8b86-4d01-b42d-00c04fc964ff"

    @Test
    fun anAccountThatChangedTakesTheirOwnWords() {
        assertTrue(personalCheck(grace, MemberStanding.CHANGED, null))
        assertTrue(personalCheck(grace.uppercase(), MemberStanding.NOT_VERIFIED, grace))
        assertFalse(personalCheck(grace, MemberStanding.VERIFIED, grace))
        assertFalse(personalCheck(grace, MemberStanding.NOT_VERIFIED, null))
        assertFalse(personalCheck(grace, null, "someone-else"))
    }
}
