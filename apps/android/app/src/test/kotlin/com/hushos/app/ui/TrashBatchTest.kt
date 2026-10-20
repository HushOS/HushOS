package com.hushos.app.ui

import com.hushos.app.data.ApiError
import com.hushos.app.data.NodeView
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.BatchRefused
import com.hushos.app.data.TrashItem
import com.hushos.app.data.TrashMove
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

        /*
         * `send` answers for one item, as the server would; the batch goes through the data layer's
         * sequencing. Items in `withFolder` went with a folder (`covered`), the rest on their own.
         */
        fun steps(send: (Opened) -> Unit) = steps(emptySet(), send)
        fun steps(withFolder: Set<String>, send: (Opened) -> Unit) = TrashSteps(
            send = { batch, moved ->
                batches.add(batch.map { it.id })
                oneAfterAnother(batch) {
                    send(it); events.add("sent ${it.id}"); moved(listOf(it))
                    if (it.id in withFolder) TrashMove.WITH_FOLDER else TrashMove.TRASHED
                }
            },
            drop = { items -> items.forEach { item -> events.add("drop ${item.id}"); dropped.add(item.id) } },
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
        // A refusal, then no network: the second may have landed, so nothing is said to have stayed.
        val mixed = trashMany(thirteen, Recorder().steps { if (it.id == "f2") throw ApiError(409, "x") else if (it.id == "f4") throw Unreachable() })
        assertEquals(TrashFailure.UNCONFIRMED, mixed.failure)
        // No network at the twelfth: nothing after it was sent, and none of it counts as moved.
        val offline = trashMany(thirteen, Recorder().steps { if (it.id == "f12") throw Unreachable() })
        assertEquals("11 of 13 moved to Trash. You’re offline, so the rest weren’t confirmed.", offline.notice())
        val signedOut = trashMany(thirteen, Recorder().steps { if (it.id == "f2") throw ApiError(409, "x") else if (it.id == "f4") throw NotAuthenticated() })
        assertEquals(TrashFailure.SIGNED_OUT, signedOut.failure)
        // Only refusals: those did stay where they were.
        val refused = trashMany(thirteen, Recorder().steps { if (it.id == "f2" || it.id == "f4") throw ApiError(409, "x") })
        assertEquals("11 of 13 moved to Trash. The rest stayed where they were. Try again.", refused.notice())
    }

    @Test
    fun aGatewayErrorIsUnconfirmedNeverStayed() = runBlocking {
        // A 502 or 504 can come after the trash committed behind the gateway.
        val partial = trashMany(thirteen, Recorder().steps { if (it.id == "f12") throw ApiError(502, "Bad gateway") })
        assertEquals("12 of 13 moved to Trash. The rest weren’t confirmed. Try again.", partial.notice())
        val none = trashMany(thirteen.take(2), Recorder().steps { throw ApiError(504, "Gateway timeout") })
        assertEquals("Couldn’t move to Trash. HushOS didn’t confirm it. Try again.", none.notice())
        assertEquals(TrashFailure.OTHER, trashFailure(ApiError(500, "x")))
    }

    private fun trashRow(item: Opened) = TrashItem(item, false)

    @Test
    fun undoPutsBackOnlyWhatCameBackOnceInListOrderAndOnlyInFoldersOnScreen() {
        val work = listOf(item("Budget", "work"), item("Zebra", "work"))
        val folders = mapOf("work" to work, "photos" to emptyList<Opened>())
        val back = listOf(item("apple", "work"), item("Zebra", "work"), item("elsewhere", "music"))
        val (rows, _) = afterUndo(folders, emptyList(), back)
        // "apple" joins Work in name order, "Zebra" isn't doubled, and a folder not on screen gets no list.
        assertEquals(listOf("apple", "Budget", "Zebra"), rows.getValue("work").map { it.id })
        assertEquals(emptyList<String>(), rows.getValue("photos").map { it.id })
        assertEquals(setOf("work", "photos"), rows.keys)
    }

    @Test
    fun undoTakesWhatCameBackOffTheTrashListAndLeavesTheRest() {
        val trashed = listOf(item("a"), item("b"), item("c"))
        val (_, trash) = afterUndo(emptyMap(), trashed.map(::trashRow), listOf(trashed[0], trashed[2]))
        assertEquals(listOf("b"), trash.map { it.item.id })
    }

    @Test
    fun anUndoOfManySaysWhatDidntComeBack() {
        assertNull(undoProblem(13, 13))
        assertNull(undoProblem(0, 1))
        assertEquals("11 of 13 are back. The rest are still in Trash.", undoProblem(11, 13))
        assertEquals("Couldn’t bring them back. They’re still in Trash.", undoProblem(0, 13))
    }

    @Test
    fun anItemThatWentWithItsFolderCountsAsMovedButUndoLeavesItToTheFolder() = runBlocking {
        val recorder = Recorder()
        val result = trashMany(thirteen, recorder.steps(withFolder = setOf("f2", "f5")) { })
        assertEquals("Moved 13 items to Trash", recorder.notices.single().first)
        assertEquals(thirteen.map { it.id }, recorder.dropped)
        // Undo puts back what went on its own; f2 and f5 come back with their folder.
        assertEquals(thirteen.map { it.id } - setOf("f2", "f5"), recorder.notices.single().second)
        assertEquals(13, result.moved.size)
    }

    @Test
    fun nothingOfItsOwnToPutBackMeansNoUndo() = runBlocking {
        val recorder = Recorder()
        trashMany(thirteen.take(2), recorder.steps(withFolder = setOf("f1", "f2")) { })
        assertEquals("Moved 2 items to Trash" to null, recorder.notices.single())
    }

    @Test
    fun aBusyOrRateLimitedRequestSaysSoInTheWebsWords() = runBlocking {
        val busy = trashMany(thirteen, Recorder().steps { if (it.id == "f13") throw BatchRefused(BatchRefused.Kind.BUSY) })
        assertEquals("12 of 13 moved to Trash. Too many changes are being made here at once. Please try again.", busy.notice())
        val none = trashMany(thirteen.take(3), Recorder().steps { throw BatchRefused(BatchRefused.Kind.TOO_MANY) })
        assertEquals("Couldn’t move to Trash. Too many requests. Please try again shortly.", none.notice())
        val large = trashMany(thirteen.take(3), Recorder().steps { throw BatchRefused(BatchRefused.Kind.TOO_LARGE) })
        assertEquals(TrashFailure.TOO_LARGE, large.failure)
    }
}
