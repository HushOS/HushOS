package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/* The server never sees the password (OPAQUE), so these checks are the only thing between a short one and an account. */
class SignupRulesTest {
    @Test
    fun aPasswordNeedsTwelveToOneHundredTwentyEightCharacters() {
        assertNotNull(SignupRules.password("a".repeat(11)))
        assertNull(SignupRules.password("a".repeat(12)))
        assertNull(SignupRules.password("a".repeat(128)))
        assertNotNull(SignupRules.password("a".repeat(129)))
        assertNotNull(SignupRules.password(""))
    }

    /* Counted as the web counts (UTF-16 units): six emoji are twelve, as in the browser, so both accept the same passwords. */
    @Test
    fun aPasswordIsCountedAsTheWebCountsIt() {
        assertNull(SignupRules.password("🔑".repeat(6)))
        assertNotNull(SignupRules.password("🔑".repeat(5) + "a"))
    }

    @Test
    fun theConfirmationMustMatchExactly() {
        assertNull(SignupRules.confirm("correct horse battery", "correct horse battery"))
        assertEquals("The passwords don’t match.", SignupRules.confirm("correct horse battery", "correct horse battery "))
        assertNotNull(SignupRules.confirm("correct horse battery", "Correct horse battery"))
    }

    @Test
    fun aNameIsTrimmedAndBetweenOneAndOneHundredCharacters() {
        assertNotNull(SignupRules.name("   "))
        assertNull(SignupRules.name(" Maya "))
        assertNull(SignupRules.name(" " + "m".repeat(100) + " "))
        assertNotNull(SignupRules.name("m".repeat(101)))
    }

    @Test
    fun anEmailNeedsAnAtAndADomain() {
        assertNull(SignupRules.email(" maya@example.com "))
        assertNotNull(SignupRules.email("maya"))
        assertNotNull(SignupRules.email("maya@example"))
        assertNotNull(SignupRules.email("ma ya@example.com"))
        assertNotNull(SignupRules.email("a@" + "b".repeat(250) + ".com"))
    }

    @Test
    fun theTermsMustBeAgreedTo() {
        assertNotNull(SignupRules.agreed(false))
        assertNull(SignupRules.agreed(true))
    }
}
