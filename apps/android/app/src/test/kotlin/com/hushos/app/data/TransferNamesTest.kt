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

    @Test
    fun theLockScreensCopiesNameNoFileAndStillSayWhatHappened() {
        val names = listOf("Divorce papers.pdf", "Biopsy results.png", "Lisbon")
        val cases = listOf(
            listOf(TransferNotices.Outcome("1", names[0], upload = true)),
            listOf(TransferNotices.Outcome("1", names[0], upload = true), TransferNotices.Outcome("2", names[1], upload = true, reason = "It didn’t upload.")),
            listOf(TransferNotices.Outcome("3", names[2], upload = false)),
            listOf(TransferNotices.Outcome("1", names[0], upload = true), TransferNotices.Outcome("3", names[2], upload = false)),
        )
        for (ended in cases) {
            val shown = TransferNotices.publicWords(ended)
            // The full summary does name them (behind the lock); its public copy never does.
            assertTrue(names.any { TransferNotices.words(ended).toList().joinToString().contains(it) })
            assertFalse("“$shown” names a file", names.any { shown.contains(it) } || shown.contains("“"))
        }
        assertEquals("1 file uploaded", TransferNotices.publicWords(cases[0]))
        assertEquals("1 upload didn’t finish", TransferNotices.publicWords(cases[1]))
        assertEquals("1 item kept on this phone", TransferNotices.publicWords(cases[2]))
        assertFalse(TransferQueue.publicTitle(keeping = false).contains("“"))
    }
}
