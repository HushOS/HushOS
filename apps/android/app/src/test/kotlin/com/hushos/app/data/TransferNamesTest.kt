package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* A transfer's name is cut in the middle so the extension shows; the out-of-room refusal is told apart from other failures. */
class TransferNamesTest {
    @Test
    fun aLongNameKeepsItsStartAndExtension() {
        val short = TransferQueue.shortName("Quarterly report for the board, final draft v7.pdf", 32)
        assertEquals(32, short.length)
        assertTrue(short.startsWith("Quarterly report"))
        assertTrue(short.endsWith("v7.pdf"))
        assertTrue("…" in short)
    }

    @Test
    fun aShortNameIsLeftAlone() {
        assertEquals("notes.md", TransferQueue.shortName("notes.md", 32))
    }

    @Test
    fun outOfRoomIsToldApartFromOtherFailures() {
        assertTrue(TransferQueue.isNoRoom(TransferQueue.NO_ROOM))
        assertTrue(TransferQueue.isNoRoom("Not enough storage for this file."))
        assertFalse(TransferQueue.isNoRoom("Couldn’t reach HushOS. Check your connection, then retry."))
        assertFalse(TransferQueue.isNoRoom(null))
    }
}
