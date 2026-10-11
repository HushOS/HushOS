package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* A picked folder's folders are made parents first, each once, so a child never waits on a parent that isn't there. */
class FolderPickTest {
    /* Where each planned path sits, failing when one appears twice. */
    private fun positions(plan: List<List<String>>): Map<List<String>, Int> {
        val at = HashMap<List<String>, Int>()
        plan.forEachIndexed { index, path -> assertTrue("$path planned twice", at.put(path, index) == null) }
        return at
    }

    @Test
    fun everyPrefixIsPlannedOnceAndParentsComeFirst() {
        val plan = FolderPick.plan(
            files = listOf(listOf("Trip", "Day 1", "Evening"), listOf("Trip", "Day 1"), listOf("Trip", "Day 1", "Evening"), listOf("Trip", "Day 2")),
            folders = listOf(listOf("Trip"), listOf("Trip", "Day 3", "Empty", "Deeper"), listOf("Trip", "Day 1")),
        )
        val at = positions(plan)
        assertEquals(
            setOf(
                listOf("Trip"), listOf("Trip", "Day 1"), listOf("Trip", "Day 1", "Evening"), listOf("Trip", "Day 2"),
                listOf("Trip", "Day 3"), listOf("Trip", "Day 3", "Empty"), listOf("Trip", "Day 3", "Empty", "Deeper"),
            ),
            plan.toSet(),
        )
        for (path in plan.filter { it.size > 1 }) {
            val parent = path.dropLast(1)
            assertTrue("$parent must come before $path", at.getValue(parent) < at.getValue(path))
        }
    }

    @Test
    fun aChildListedBeforeItsParentStillWaitsForIt() {
        val plan = FolderPick.plan(files = listOf(listOf("A", "B", "C", "D")), folders = emptyList())
        assertEquals(listOf(listOf("A"), listOf("A", "B"), listOf("A", "B", "C"), listOf("A", "B", "C", "D")), plan)
    }

    @Test
    fun theSameNameInDifferentPlacesIsTwoFolders() {
        val plan = FolderPick.plan(files = listOf(listOf("A", "Notes"), listOf("A", "B", "Notes")), folders = emptyList())
        positions(plan)
        assertEquals(2, plan.count { it.last() == "Notes" })
    }

    @Test
    fun hiddenMeansALeadingDotOnly() {
        assertTrue(FolderPick.hidden(".git") && FolderPick.hidden(".DS_Store"))
        assertTrue(!FolderPick.hidden("Notes.txt") && !FolderPick.hidden("v1.2") && !FolderPick.hidden(""))
    }

    @Test
    fun nothingPickedPlansNothing() {
        assertTrue(FolderPick.plan(emptyList(), emptyList()).isEmpty())
    }
}
