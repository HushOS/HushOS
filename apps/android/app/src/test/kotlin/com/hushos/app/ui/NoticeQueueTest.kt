package com.hushos.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * The app's one notice on screen (DriveState.notice), as NoticeQueue keeps it: an until-read notice is never lost to the
 * next one. Fails if a notice that stays until read is replaced unread, or doesn't come back after a passing one.
 */
class NoticeQueueTest {
    private var shown: Notice? = null
    private val queue = NoticeQueue { shown = it }
    private var next = 0L
    private fun notice(text: String) = Notice(++next, text, {}, "OK")

    @Test
    fun untilReadNoticesWaitTheirTurnAndComeBackAfterAPassingOne() {
        queue.untilRead(notice("first"))
        queue.untilRead(notice("second"))
        assertEquals("first", shown?.text)
        // A passing notice covers the first for its moment, then the first is back, unread.
        val passing = Notice(++next, "Invitation sent", null, "Undo")
        queue.passing(passing)
        assertEquals("Invitation sent", shown?.text)
        queue.expire(passing.id)
        assertEquals("first", shown?.text)
        queue.dismiss()
        assertEquals("second", shown?.text)
        queue.dismiss()
        assertNull(shown)
    }

    @Test
    fun passingNoticesReplaceEachOtherAndAStaleExpiryChangesNothing() {
        val a = Notice(++next, "a", null, "Undo")
        val b = Notice(++next, "b", null, "Undo")
        queue.passing(a)
        queue.passing(b)
        queue.expire(a.id)
        assertEquals("b", shown?.text)
        queue.untilRead(notice("kept"))
        queue.clear()
        assertNull(shown)
        queue.dismiss()
        assertNull(shown)
    }
}
