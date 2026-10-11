package com.hushos.app.data

import com.hushos.app.data.UploadNames.Placement.Clash
import com.hushos.app.data.UploadNames.Placement.Free
import org.junit.Assert.assertEquals
import org.junit.Test

/* Each picked file is placed on its own, by its position in the pick: two picks can share a name. */
class UploadNamesTest {
    @Test
    fun twoFreePicksOfOneNameLandUnderTwoNames() {
        val taken = mutableSetOf("day 1", "cover.jpg")
        val placed = UploadNames.place(listOf("Notes.txt", "Notes.txt"), listOf("Cover.jpg"), taken)
        assertEquals(listOf(Free("Notes.txt"), Free("Notes (2).txt")), placed)
        assertEquals(setOf("day 1", "cover.jpg", "notes.txt", "notes (2).txt"), taken)
    }

    @Test
    fun aDifferentCaseIsStillTheSameName() {
        val placed = UploadNames.place(listOf("notes.txt", "NOTES.TXT", "Notes.txt"), emptyList(), mutableSetOf())
        assertEquals(listOf(Free("notes.txt"), Free("NOTES (2).TXT"), Free("Notes (3).txt")), placed)
    }

    @Test
    fun everyPickOfATakenNameIsItsOwnQuestion() {
        val placed = UploadNames.place(listOf("Notes.txt", "Plan.txt", "notes.txt"), listOf("Notes.txt"), mutableSetOf("notes.txt"))
        assertEquals(listOf(Clash, Free("Plan.txt"), Clash), placed)
    }

    @Test
    fun aMovedNameSkipsNamesAlreadyThere() {
        val placed = UploadNames.place(listOf("Notes.txt", "Notes.txt"), listOf("Notes (2).txt"), mutableSetOf("notes (2).txt"))
        assertEquals(listOf(Free("Notes.txt"), Free("Notes (3).txt")), placed)
    }

    @Test
    fun aFileMayShareItsNameWithAFolderThere() {
        assertEquals(listOf(Free("Day 1")), UploadNames.place(listOf("Day 1"), emptyList(), mutableSetOf("day 1")))
    }

    @Test
    fun freeNamesCountUpAndKeepTheExtension() {
        assertEquals("report.pdf", UploadNames.freeName("report.pdf", emptySet()))
        assertEquals("report (3).pdf", UploadNames.freeName("report.pdf", setOf("report.pdf", "report (2).pdf")))
        assertEquals("README (2)", UploadNames.freeName("README", setOf("readme")))
    }
}
