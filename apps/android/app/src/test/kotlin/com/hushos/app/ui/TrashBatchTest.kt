package com.hushos.app.ui

import com.hushos.app.data.ApiError
import com.hushos.app.data.NodeView
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.Unreachable
import com.hushos.app.data.oneAfterAnother
import com.hushos.core.NodeMetadata
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Move to Trash for many: only what the server moved is counted, offered back and taken off the
 * lists; the batch reaches the data layer in one call (Vault.trashMany, the seam a batch route
 * replaces); and the follow-up (feed, listings, the system's view) runs once for the batch, after
 * the rows are gone and the notice is up.
 */
class TrashBatchTest {
    private fun item(id: String, parent: String = "work") = Opened(
        NodeView(id, "ws", parent, "file", 1uL, 1uL, "", 1uL, "", null, null, null, null),
        NodeMetadata(id, null, 10uL, null),
    )

    private val thirteen = (1..13).map { item("f$it", parent = if (it % 2 == 0) "work" else "photos") }

    /* Records what each step got, and in which order the steps ran. */
    private class Recorder {
        val events = ArrayList<String>()
        val batches = ArrayList<List<String>>()
        val dropped = ArrayList<List<String>>()
        val notices = ArrayList<Pair<String, List<String>>>()
        val settled = ArrayList<Set<String>>()

        /* `send` answers for one item, as the server would; the batch goes through the data layer's sequencing. */
        fun steps(send: (Opened) -> Unit) = TrashSteps(
            send = { batch -> batches.add(batch.map { it.id }); oneAfterAnother(batch) { send(it); events.add("sent ${it.id}") } },
            drop = { moved -> events.add("drop"); dropped.add(moved.map { it.id }) },
            announce = { text, undo -> events.add("announce"); notices.add(text to undo.map { it.id }) },
            settle = { folders -> events.add("settle"); settled.add(folders) },
        )
    }

    private val failing = setOf("f3", "f8")
    private val failsSome: (Opened) -> Unit = { if (it.id in failing) throw ApiError(500, "Server said something internal") }

    @Test
    fun aFailedItemIsNotCountedAsMoved() = runBlocking {
        val recorder = Recorder()
        val result = trashMany(thirteen, recorder.steps(failsSome))
        assertEquals(thirteen.map { it.id } - failing, result.moved.map { it.id })
        // The server's own sentence never reaches the notice; the count is of what moved.
        assertEquals("11 of 13 moved to Trash. The rest stayed where they were. Try again.", recorder.notices.single().first)
    }

    @Test
    fun undoOffersBackOnlyWhatMoved() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen, recorder.steps(failsSome))
        assertEquals(thirteen.map { it.id } - failing, recorder.notices.single().second)
        // Rows that stayed are not taken off the lists either.
        assertEquals(thirteen.map { it.id } - failing, recorder.dropped.single())
    }

    @Test
    fun theFollowUpRunsOnceAfterEveryRequestNotOncePerItem() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen, recorder.steps { })
        assertEquals(listOf(setOf("work", "photos")), recorder.settled)
        // Every request answered, then the rows go, then the notice, then the follow-up.
        val after = recorder.events.drop(13)
        assertTrue(recorder.events.take(13).all { it.startsWith("sent ") })
        assertEquals(listOf("drop", "announce", "settle"), after)
    }

    @Test
    fun theWholeBatchReachesTheDataLayerInOneCall() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen, recorder.steps { })
        // One call with every item, in order: the one place a batch route will take over.
        assertEquals(listOf(thirteen.map { it.id }), recorder.batches)
    }

    @Test
    fun everythingMovedIsSaidPlainly() = runBlocking {
        val many = Recorder().also { trashMany(thirteen, it.steps { }) }
        assertEquals("Moved 13 items to Trash", many.notices.single().first)
        val one = Recorder().also { trashMany(listOf(item("Report.pdf")), it.steps { }) }
        assertEquals("Moved “Report.pdf” to Trash" to listOf("Report.pdf"), one.notices.single())
        assertEquals(listOf(setOf("work")), one.settled)
    }

    @Test
    fun aSingleItemThatFailedIsLeftToTheCallerAndNothingFollows() = runBlocking {
        val recorder = Recorder()
        val result = trashMany(listOf(item("f3")), recorder.steps(failsSome))
        assertTrue(result.moved.isEmpty())
        assertNull(result.notice())
        assertTrue(recorder.notices.isEmpty() && recorder.dropped.isEmpty() && recorder.settled.isEmpty())
    }

    @Test
    fun nothingMovedOfManySaysSoWithNoUndoAndNoFollowUp() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen, recorder.steps { throw Unreachable() })
        assertEquals("Couldn’t move to Trash. You’re offline. Try again once you’re connected." to emptyList<String>(), recorder.notices.single())
        assertTrue(recorder.dropped.isEmpty() && recorder.settled.isEmpty())
    }

    @Test
    fun theReasonIsOfflineOnlyWhenEveryFailureWas() = runBlocking {
        // A refusal, then no network: the reason can't honestly be "offline" alone.
        val mixed = trashMany(thirteen, Recorder().steps { if (it.id == "f2") throw ApiError(409, "x") else if (it.id == "f4") throw Unreachable() })
        assertEquals(TrashFailure.OTHER, mixed.failure)
        // No network at the twelfth: nothing after it was sent, and none of it counts as moved.
        val offline = trashMany(thirteen, Recorder().steps { if (it.id == "f12") throw Unreachable() })
        assertEquals("11 of 13 moved to Trash. You’re offline, so the rest weren’t confirmed.", offline.notice())
        val signedOut = trashMany(thirteen, Recorder().steps { if (it.id == "f2") throw ApiError(409, "x") else if (it.id == "f4") throw NotAuthenticated() })
        assertEquals(TrashFailure.SIGNED_OUT, signedOut.failure)
    }
}
