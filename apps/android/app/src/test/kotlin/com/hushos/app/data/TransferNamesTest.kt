package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Transfer notifications name no file in any field: a lock screen showing all content, and every app allowed to read
 * notifications, sees them whole. They count and say what kind; the transfers sheet in the app names the files. The
 * out-of-room refusal is told apart from other failures.
 */
class TransferNamesTest {
    private val names = listOf("Divorce papers.pdf", "Biopsy results.png", "Lisbon")

    private fun assertNamesNothing(text: NoticeText) {
        for (field in text.fields) {
            for (name in names) assertFalse("“$field” names $name", field.contains(name, ignoreCase = true) || field.contains(name.substringBeforeLast('.'), ignoreCase = true))
            assertFalse("“$field” quotes something", field.contains("“"))
        }
    }

    @Test
    fun noFinishedOrFailedSummaryNamesAFileInAnyField() {
        val cases = listOf(
            listOf(TransferNotices.Outcome("1", names[0], upload = true)),
            listOf(TransferNotices.Outcome("1", names[0], upload = true), TransferNotices.Outcome("2", names[1], upload = true, reason = "It didn’t upload.")),
            listOf(TransferNotices.Outcome("1", names[0], upload = true, reason = "Couldn’t reach HushOS."), TransferNotices.Outcome("2", names[1], upload = true, reason = "Not enough room for this file.")),
            listOf(TransferNotices.Outcome("3", names[2], upload = false)),
            listOf(TransferNotices.Outcome("1", names[0], upload = true), TransferNotices.Outcome("3", names[2], upload = false)),
        )
        for (ended in cases) for (retry in listOf(false, true)) assertNamesNothing(TransferNotices.words(ended, retry))
        // Still says what happened, and where to look.
        assertEquals("1 file uploaded", TransferNotices.words(cases[0]).title)
        val failed = TransferNotices.words(cases[1], retry = true)
        assertEquals("1 upload didn’t finish", failed.title)
        assertEquals("Open HushOS to see it and try again.", failed.text)
        assertEquals(listOf(TransferNotices.RETRY_LABEL), failed.actions)
        assertEquals("2 uploads didn’t finish", TransferNotices.words(cases[2]).title)
        assertEquals("1 item kept on this phone", TransferNotices.words(cases[3]).title)
    }

    /*
     * A finished summary always has a second line: with a title alone, One UI drew a tall, empty card. The line says
     * where the tap goes, and the tap goes there (one folder, On this phone, or Files when they went to several places).
     */
    @Test
    fun aFinishedSummaryHasASecondLineThatMatchesWhereTheTapGoes() {
        val one = listOf(TransferNotices.Outcome("1", names[0], upload = true, folder = "f1"))
        val twoInOne = one + TransferNotices.Outcome("2", names[1], upload = true, folder = "f1")
        val twoPlaces = one + TransferNotices.Outcome("2", names[1], upload = true, folder = "f2")
        val kept = listOf(TransferNotices.Outcome("3", names[2], upload = false))
        val mixed = one + kept
        val expected = listOf(
            one to (TransferNotices.Target.FOLDER to "Tap to open the folder it’s in."),
            twoInOne to (TransferNotices.Target.FOLDER to "Tap to open the folder they’re in."),
            twoPlaces to (TransferNotices.Target.FILES to "Tap to see them in Files."),
            kept to (TransferNotices.Target.PHONE to "Tap to see it on this phone."),
            mixed to (TransferNotices.Target.FILES to "Tap to see them in Files."),
        )
        for ((ended, want) in expected) {
            val words = TransferNotices.words(ended)
            assertEquals(want.first, TransferNotices.target(ended))
            assertEquals(want.second, words.text)
            // No big style on a finished one: the line is the whole notification.
            assertEquals(null, words.bigText)
            // A lock screen hiding content shows the public version: never a title over an empty card.
            assertEquals(TransferNotices.PUBLIC_TEXT, words.publicText)
            assertNamesNothing(words)
        }
        // A failure among them goes to the transfers sheet and says so.
        val failed = twoInOne + TransferNotices.Outcome("4", names[0], upload = true, reason = "Couldn’t reach HushOS.", folder = "f1")
        assertEquals(TransferNotices.Target.TRANSFERS, TransferNotices.target(failed))
        assertEquals("Open HushOS to see it and try again.", TransferNotices.words(failed).text)
    }

    @Test
    fun theOngoingNotificationCountsTransfersAndNamesNone() {
        for (keeping in listOf(false, true)) for (count in listOf(0, 1, 3)) assertNamesNothing(TransferQueue.ongoingText(keeping, count, 0.4f))
        assertEquals("Uploading 3 files", TransferQueue.ongoingText(false, 3, 0f).title)
        assertEquals("Keeping 1 item on this phone", TransferQueue.ongoingText(true, 0, 0f).title)
        assertEquals("40%", TransferQueue.ongoingText(false, 1, 0.4f).text)
        // Before the first part lands it still has a second line, not a bare title.
        assertEquals("Starting", TransferQueue.ongoingText(false, 1, 0f).text)
    }

    @Test
    fun outOfRoomIsToldApartFromOtherFailures() {
        assertTrue(TransferQueue.isNoRoom(TransferQueue.NO_ROOM))
        assertTrue(TransferQueue.isNoRoom("Not enough storage for this file."))
        assertFalse(TransferQueue.isNoRoom("Couldn’t reach HushOS. Check your connection, then retry."))
        assertFalse(TransferQueue.isNoRoom(null))
    }
}
