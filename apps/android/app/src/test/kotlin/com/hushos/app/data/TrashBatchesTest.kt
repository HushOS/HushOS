package com.hushos.app.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A selection through the batch routes: 200 ids a request, a request per workspace; what counts
 * as moved; a whole request refused or unanswered; Undo with folders first and `parent-trashed`
 * tried again; and the fall back to one request an item on a server without the routes.
 */
class TrashBatchesTest {
    private fun ids(n: Int, prefix: String = "n") = (1..n).map { "$prefix$it" }

    /* A fake server: each request recorded; every id trashed unless `answer` says otherwise. */
    private class Server(val answer: (String) -> BatchAnswer? = { Trashed(it, "now", 1) }) {
        val requests = ArrayList<Pair<String, List<String>>>()
        var fail: ((String, List<String>) -> Throwable?) = { _, _ -> null }
        fun send(workspace: String, chunk: List<String>): List<BatchAnswer> {
            requests.add(workspace to chunk)
            fail(workspace, chunk)?.let { throw it }
            return chunk.mapNotNull(answer)
        }
    }

    private suspend fun trash(items: List<Pair<String, String>>, server: Server, sequential: suspend (List<String>) -> List<Result<TrashMove>> = { error("not used") }): Pair<List<Result<TrashMove>>, List<String>> {
        val moved = ArrayList<String>()
        return trashInBatches(items, server::send, sequential) { landed -> moved.addAll(landed.map { it.first }) } to moved
    }

    @Test
    fun aLargeSelectionGoesInRequestsOfTwoHundredOnePerWorkspace() = runBlocking {
        val items = ids(250).map { it to "own" } + ids(3, "s").map { it to "shared" }
        val server = Server()
        val (outcomes, moved) = trash(items, server)
        assertEquals(listOf("own" to 200, "own" to 50, "shared" to 3), server.requests.map { it.first to it.second.size })
        assertEquals(items.map { it.first }, server.requests.flatMap { it.second })
        assertTrue(outcomes.all { it.getOrNull() == TrashMove.TRASHED })
        assertEquals(253, moved.size)
    }

    @Test
    fun whatARequestMovedLandsTogetherOncePerRequest() = runBlocking {
        // One landing a request, so the lists drop a request's rows in one update, not one per row.
        val sizes = ArrayList<Int>()
        trashInBatches(ids(250).map { it to "own" }, Server()::send, { error("not used") }) { landed -> sizes.add(landed.size) }
        assertEquals(listOf(200, 50), sizes)
    }

    @Test
    fun aRowIsForgottenOnlyOnceTheListsLetGoOfIt() = runBlocking {
        // The screen: a row it still shows whose node this device forgot is looked up again (a
        // thumbnail, a listing), which cost 115 to 156 listings a 251-item batch. Refused rows stay known.
        val onScreen = ids(250).toMutableSet()
        val forgotten = ArrayList<String>()
        var lookedUpAgain = 0
        val server = Server { if (it == "n7") BatchRefusal(it, "forbidden", "You can’t change this.") else Trashed(it, "now", 1) }
        trashInBatches(
            ids(250).map { it to "own" }, server::send, { error("not used") },
            forget = { landed -> landed.forEach { id -> if (id in onScreen) lookedUpAgain++; forgotten.add(id) } },
        ) { landed -> onScreen.removeAll(landed.map { it.first }.toSet()) }
        assertEquals(0, lookedUpAgain)
        assertEquals(ids(250) - "n7", forgotten)
        assertEquals(setOf("n7"), onScreen)
    }

    @Test
    fun coveredOrAlreadyInTheTrashCountsAsMovedWithItsFolder() = runBlocking {
        val server = Server { id ->
            when (id) {
                "n2" -> Covered(id, "n1")
                "n3" -> BatchRefusal(id, "trashed", "This item is in the trash.")
                "n4" -> BatchRefusal(id, "forbidden", "You can’t change this.")
                else -> Trashed(id, "now", 1)
            }
        }
        val (outcomes, moved) = trash(ids(4).map { it to "own" }, server)
        assertEquals(listOf(TrashMove.TRASHED, TrashMove.WITH_FOLDER, TrashMove.WITH_FOLDER), outcomes.take(3).map { it.getOrNull() })
        assertTrue(outcomes[3].isFailure)
        assertEquals(listOf("n1", "n2", "n3"), moved)
    }

    @Test
    fun anItemLeftOutOfTheAnswerIsUnconfirmed() = runBlocking {
        val (outcomes, moved) = trash(ids(3).map { it to "own" }, Server { if (it == "n2") null else Trashed(it, "now", 1) })
        assertEquals(502, (outcomes[1].exceptionOrNull() as ApiError).status)
        assertEquals(listOf("n1", "n3"), moved)
    }

    @Test
    fun aBusyRequestFailsItsOwnChunkOnlyAndIsNotRetried() = runBlocking {
        val server = Server().apply { fail = { _, chunk -> if (chunk.first() == "n1") BatchRefused(BatchRefused.Kind.BUSY) else null } }
        val (outcomes, _) = trash(ids(250).map { it to "own" }, server)
        assertEquals(2, server.requests.size)
        assertTrue(outcomes.take(200).all { it.exceptionOrNull() is BatchRefused })
        assertTrue(outcomes.drop(200).all { it.isSuccess })
    }

    @Test
    fun aLostResponseLeavesItsChunkUnconfirmedAndSendsNoMore() = runBlocking {
        val server = Server().apply { fail = { _, _ -> Unreachable() } }
        val (outcomes, moved) = trash(ids(450).map { it to "own" }, server)
        assertEquals(1, server.requests.size)
        assertTrue(outcomes.all { it.exceptionOrNull() is Unreachable })
        assertTrue(moved.isEmpty())
    }

    @Test
    fun aServerWithoutTheRouteFallsBackToOneRequestAnItemForEveryRemainingChunk() = runBlocking {
        val server = Server().apply { fail = { _, _ -> BatchUnsupported() } }
        val sent = ArrayList<String>()
        val (outcomes, _) = trash(ids(250).map { it to "own" }, server) { chunk -> sent.addAll(chunk); chunk.map { Result.success(TrashMove.TRASHED) } }
        // One batch request found the route missing; nothing after it tried the route again.
        assertEquals(1, server.requests.size)
        assertEquals(ids(250), sent)
        assertTrue(outcomes.all { it.isSuccess })
    }

    @Test
    fun theReplyIsReadAsTheServerMeantIt() {
        // No route: 501 `unsupported` now, a bare 404 on servers from before; the drive's own 404 is not that.
        assertThrows<BatchUnsupported> { batchAnswers(501, """{"message":"This server does not offer that yet.","code":"unsupported"}""") }
        assertThrows<BatchUnsupported> { batchAnswers(404, """{"message":"Not found."}""") }
        assertThrows<NotFound> { batchAnswers(404, """{"message":"This item no longer exists.","code":"not-found"}""") }
        assertEquals(BatchRefused.Kind.BUSY, assertThrows<BatchRefused> { batchAnswers(409, """{"message":"Too many changes","code":"conflict"}""") }.kind)
        assertEquals(BatchRefused.Kind.TOO_MANY, assertThrows<BatchRefused> { batchAnswers(429, """{"message":"Too many requests.","code":"conflict"}""") }.kind)
        assertEquals(BatchRefused.Kind.TOO_LARGE, assertThrows<BatchRefused> { batchAnswers(413, """{"message":"Request is too large.","code":"too-large"}""") }.kind)
        assertThrows<NotAuthenticated> { batchAnswers(401, "") }
        val answers = batchAnswers(200, """{"results":[{"id":"a","status":"trashed","trashedAt":"t","changeSeq":7},{"id":"b","status":"covered","by":"a"},{"id":"c","status":"refused","reason":"root","message":"No"},{"id":"d","status":"restored","changeSeq":9}]}""")
        assertEquals(listOf(Trashed("a", "t", 7), Covered("b", "a"), BatchRefusal("c", "root", "No"), Restored("d", 9)), answers)
        assertEquals(502, assertThrows<ApiError> { batchAnswers(200, "<html>") }.status)
    }

    /* Undo: `depth` from a parent map of the given items. */
    private val parents = mapOf("a" to null, "b" to "a", "c" to "b", "x" to null)
    private fun depth(id: String): Int { var n = 0; var at = parents[id]; while (at != null) { n++; at = parents[at] }; return n }

    @Test
    fun undoSendsFoldersBeforeWhatIsInThemWhateverTheOrderGiven() = runBlocking {
        val server = Server { Restored(it, 2) }
        val outcomes = restoreInBatches(listOf("c", "x", "b", "a").map { it to "own" }, ::depth, server::send, { error("not used") })
        assertEquals(listOf("x", "a", "b", "c").toSet(), server.requests.single().second.toSet())
        val order = server.requests.single().second
        assertTrue(order.indexOf("a") < order.indexOf("b") && order.indexOf("b") < order.indexOf("c"))
        assertTrue(outcomes.all { it.isSuccess })
    }

    @Test
    fun anItemWaitingForItsFolderIsTriedAgainAfterTheRestLanded() = runBlocking {
        // The folder comes back only in a later request; its file was refused until then.
        val restored = HashSet<String>()
        val server = Server { id ->
            if (id == "b" && "a" !in restored) BatchRefusal(id, "parent-trashed", "Its folder is in the trash.")
            else Restored(id, 2).also { restored.add(id) }
        }
        val items = ids(200, "f").map { it to "own" } + ("b" to "own") + ("a" to "other")
        val outcomes = restoreInBatches(items, { 0 }, server::send, { error("not used") })
        assertEquals(listOf("own", "own", "other", "own"), server.requests.map { it.first })
        assertEquals(listOf("b"), server.requests.last().second)
        assertTrue(outcomes.all { it.isSuccess })
    }

    @Test
    fun aRefusalThatNothingChangesIsNotTriedForever() = runBlocking {
        val server = Server { BatchRefusal(it, "parent-trashed", "Its folder is in the trash.") }
        val outcomes = restoreInBatches(listOf("b" to "own"), { 0 }, server::send, { error("not used") })
        assertEquals(2, server.requests.size)
        assertTrue(outcomes.single().isFailure)
    }

    @Test
    fun undoOnAServerWithoutTheRouteRestoresOneByOne() = runBlocking {
        val server = Server().apply { fail = { _, _ -> BatchUnsupported() } }
        val sent = ArrayList<String>()
        val outcomes = restoreInBatches(listOf("c", "a", "b").map { it to "own" }, ::depth, server::send, { chunk -> sent.addAll(chunk); chunk.map { Result.success(Unit) } })
        // Still folders first, one request each.
        assertEquals(listOf("a", "b", "c"), sent)
        assertTrue(outcomes.all { it.isSuccess })
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit): T {
        try { block() } catch (error: Throwable) { if (error is T) return error; throw AssertionError("threw $error") }
        throw AssertionError("nothing thrown")
    }
}
