package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * "Find someone" on People. A field that appears for a short list, vanishes under
 * the text being typed, misses someone by case or a stray space, or says nobody
 * matches a blank query would each be noticed by the person looking.
 */
class PeopleFilterTest {
    private fun pin(name: String, email: String) = ContactPin(email, email, name, "", "", "", "2026-10-15T00:00:00Z", null, null)

    @Test fun offeredFromEightPeopleAndNotBelow() {
        assertFalse(PeopleFilter.offered(7, ""))
        assertTrue(PeopleFilter.offered(8, ""))
    }

    @Test fun keptWhileTextIsTypedEvenBelowEight() {
        // The list shrank (someone removed) while "pri" was in the field: the field stays.
        assertTrue(PeopleFilter.offered(3, "pri"))
        assertTrue(PeopleFilter.offered(0, " "))
    }

    @Test fun matchesNameOrEmailTrimmedAndCaseInsensitive() {
        assertTrue(PeopleFilter.matches("Priya Shah", "p@example.com", "  SHAH "))
        assertTrue(PeopleFilter.matches("Priya Shah", "Priya.Work@Example.com", "work@example"))
        assertFalse(PeopleFilter.matches("Priya Shah", "p@example.com", "sam"))
    }

    @Test fun aBlankQueryShowsEveryoneRatherThanNobody() {
        val pins = listOf(pin("Sam Lee", "sam@example.com"), pin("Priya Shah", "priya@example.com"))
        assertEquals(listOf("sam@example.com", "priya@example.com"), PeopleFilter.shown(pins, "   ").map { it.email })
    }

    @Test fun narrowsInListOrder() {
        val pins = listOf(pin("Ana", "ana@one.test"), pin("Ben", "ben@two.test"), pin("Cara", "cara@one.test"))
        assertEquals(listOf("Ana", "Cara"), PeopleFilter.shown(pins, "ONE.test").map { it.name })
        assertTrue(PeopleFilter.shown(pins, "zed").isEmpty())
    }

    @Test fun saysWhatItFoundInTheWebsWords() {
        assertEquals("2 of 8 shown", PeopleFilter.result(2, 8, "  sa "))
        assertEquals("Nobody here matches “SA zz”.", PeopleFilter.result(0, 8, " SA zz "))
        // Nothing typed but spaces: nothing to say, and never "Nobody here matches “”.".
        assertNull(PeopleFilter.result(8, 8, "   "))
    }

    @Test fun accentsCountAsOnTheWeb() {
        assertFalse(PeopleFilter.matches("Chloé Martin", "c@example.com", "chloe"))
        assertTrue(PeopleFilter.matches("Chloé Martin", "c@example.com", "CHLOÉ"))
    }

    @Test fun aDecomposedNameMatchesWhatAKeyboardTypes() {
        // "é" stored as e + combining acute (as some systems write names), typed precomposed, and the other way round.
        assertTrue(PeopleFilter.matches("Chloe\u0301 Martin", "c@example.com", "chlo\u00e9"))
        assertTrue(PeopleFilter.matches("Chlo\u00e9 Martin", "c@example.com", "chloe\u0301"))
    }
}
