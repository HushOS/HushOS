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
 * Move to Trash for many: only what the server moved is counted, offered back by the notice's
 * Undo and taken off the lists, each row as its request is confirmed; the batch reaches the data
 * layer in one call (Vault.trashMany, the seam a batch route replaces); and the follow-up (feed,
 * listings, the system's view) runs once for the batch, after the last answer and the notice.
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
        val dropped = ArrayList<String>()
        /* Each notice's text, and what tapping its Undo restores (null: the notice has no Undo). */
        val notices = ArrayList<Pair<String, List<String>?>>()
        val settled = ArrayList<Set<String>>()
        private var restored: List<String>? = null

        /* `send` answers for one item, as the server would; the batch goes through the data layer's sequencing. */
        fun steps(send: (Opened) -> Unit) = TrashSteps(
            send = { batch, moved -> batches.add(batch.map { it.id }); oneAfterAnother(batch) { send(it); events.add("sent ${it.id}"); moved(it) } },
            drop = { item -> events.add("drop ${item.id}"); dropped.add(item.id) },
            announce = { text, undo ->
                events.add("announce")
                // Tap Undo at once: what reaches `restore` is what the person gets back.
                restored = null
                undo?.invoke()
                notices.add(text to if (undo == null) null else restored)
            },
            restore = { moved -> restored = moved.map { it.id } },
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
        assertEquals(thirteen.map { it.id } - failing, recorder.dropped)
    }

    @Test
    fun eachRowLeavesAsItIsConfirmedAndTheFollowUpRunsOnceAtTheEnd() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen, recorder.steps { })
        assertEquals(listOf(setOf("work", "photos")), recorder.settled)
        // Each row goes right after its own answer; the notice and one follow-up come after the last.
        val expected = thirteen.flatMap { listOf("sent ${it.id}", "drop ${it.id}") } + listOf("announce", "settle")
        assertEquals(expected, recorder.events)
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
        assertEquals("Couldn’t move to Trash. You’re offline. Try again once you’re connected." to null, recorder.notices.single())
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
