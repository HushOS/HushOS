package com.hushos.app.data

import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive

/*
 * A selection to the trash, and Undo, through the batch routes (docs/drive-design.md: trash-batch
 * and restore-batch; packages/drive/src/protocol.ts): at most MAX_TRASH_BATCH ids a request, one
 * request at a time (the server takes each under the workspace's lock), grouped by workspace. The
 * rules (what counts as moved, what Undo sends and in which order, when to stop, when to fall
 * back to one request an item) live here, with the requests passed in, so the tests reach them.
 */
const val MAX_TRASH_BATCH = 200

/* One item's answer in a batch. */
sealed interface BatchAnswer { val id: String }
data class Trashed(override val id: String, val trashedAt: String, val changeSeq: Int) : BatchAnswer
data class Covered(override val id: String, val by: String) : BatchAnswer
data class Restored(override val id: String, val changeSeq: Int) : BatchAnswer
data class BatchRefusal(override val id: String, val reason: String, val message: String) : BatchAnswer

/*
 * How an item reached the trash: on its own (Undo brings it back), or with a folder that went
 * (`covered`, or a selected folder it sits in, which is all that was sent): it is in the trash,
 * so it counts as moved, and it comes back with that folder, never on its own. An item refused as
 * `trashed` (already there, itself or through a folder) did not move, as the web counts it.
 */
enum class TrashMove { TRASHED, WITH_FOLDER }

/* A server without the batch routes (an older self-hosted one): one request an item instead. */
class BatchUnsupported : Exception("This server has no batch route")

/* A whole batch request refused before anything moved, in the web's words. */
class BatchRefused(val kind: Kind) : Refused(kind.title, kind.words) {
    enum class Kind(val title: String, val words: String) {
        BUSY("Too busy right now", "Too many changes are being made here at once. Please try again."),
        TOO_MANY("Too many tries", "Too many requests. Please try again shortly."),
        TOO_LARGE("Too many at once", "That’s too many items for one request. Select fewer and try again."),
    }
}

/* No answer for an item in a batch that did answer: its outcome isn't known, as with a lost response. */
fun unanswered() = ApiError(502, "HushOS didn’t say what happened to this item.", "unavailable")

/* What a refusal is, as the single route's error would have been. */
private fun refused(answer: BatchRefusal): Throwable =
    if (answer.reason == "not-found") NotFound(answer.message) else ApiError(409, answer.message, answer.reason)

/* A failure every later request would share: no network (or no answer), or the session ended. */
private fun stops(error: Throwable) = error is NotAuthenticated || Problems.offline(error)

/* The ids by workspace, in the order given, each workspace's in chunks of MAX_TRASH_BATCH. */
private fun chunks(items: List<Pair<String, String>>): List<Pair<String, List<Int>>> {
    val byWorkspace = LinkedHashMap<String, MutableList<Int>>()
    items.forEachIndexed { index, (_, workspace) -> byWorkspace.getOrPut(workspace) { ArrayList() }.add(index) }
    return byWorkspace.flatMap { (workspace, indexes) -> indexes.chunked(MAX_TRASH_BATCH).map { workspace to it } }
}

/*
 * Moves (id, workspace) pairs to the trash: one outcome per item, in the order given, and `moved`
 * told of what each request moved, together, as its answer lands (one update for the lists, not one
 * per row). An item inside another selected item (`ancestors`: the folders it sits in, as far as
 * this device knows) is never sent, as the web leaves it out: trashed on its own it would come
 * back on Undo without its folder. It moves with its folder, landing with that folder's request,
 * or stays with its folder's failure. A request that fails as a whole fails its items with its
 * error; no network or an ended session fails the rest unsent. `sequential` is the per-item route,
 * for a server without the batch one (the request answers BatchUnsupported); from then on every
 * remaining chunk goes that way, and it tells `moved` and `forget` of each item itself, in that
 * order. `forget` hears ids only after `moved` returned: the lists let go of a row first, or a row
 * still on screen whose node is gone is looked up again.
 */
suspend fun trashInBatches(
    items: List<Pair<String, String>>,
    send: (workspaceId: String, ids: List<String>) -> List<BatchAnswer>,
    sequential: suspend (ids: List<String>) -> List<Result<TrashMove>>,
    ancestors: (id: String) -> List<String> = { emptyList() },
    forget: (ids: List<String>) -> Unit = {},
    moved: (landed: List<Pair<String, TrashMove>>) -> Unit,
): List<Result<TrashMove>> {
    val outcomes = arrayOfNulls<Result<TrashMove>>(items.size)
    val picked = items.map { it.first }.toSet()
    // The selected folders each item sits in; the roots, inside none of them, are all that is sent.
    val within = items.map { (id, _) -> ancestors(id).filter { it != id && it in picked }.distinct() }
    val roots = items.indices.filter { within[it].isEmpty() }
    val rootOutcome = HashMap<String, Result<TrashMove>>()
    // The nested items a request's roots took with them, landing with that request.
    fun carried(landedRoots: Set<String>): List<Pair<String, TrashMove>> = items.indices.mapNotNull { index ->
        if (outcomes[index] != null || within[index].none { it in landedRoots }) return@mapNotNull null
        outcomes[index] = Result.success(TrashMove.WITH_FOLDER)
        items[index].first to TrashMove.WITH_FOLDER
    }
    var stopped: Throwable? = null
    var perItem = false
    val rootItems = roots.map { items[it] }
    for ((workspace, chunk) in chunks(rootItems)) {
        coroutineContext.ensureActive()
        val indexes = chunk.map { roots[it] }
        val ids = indexes.map { items[it].first }
        fun settle(index: Int, outcome: Result<TrashMove>) { outcomes[index] = outcome; rootOutcome[items[index].first] = outcome }
        stopped?.let { error -> indexes.forEach { settle(it, Result.failure(error)) }; continue }
        if (!perItem) {
            val answers = try {
                send(workspace, ids)
            } catch (error: BatchUnsupported) {
                perItem = true
                null
            } catch (error: Exception) {
                error.rethrowIfCancelled()
                indexes.forEach { settle(it, Result.failure(error)) }
                if (stops(error)) stopped = error
                continue
            }
            if (answers != null) {
                val byId = answers.associateBy { it.id }
                val landed = ArrayList<Pair<String, TrashMove>>()
                for (index in indexes) {
                    val id = items[index].first
                    val outcome = when (val answer = byId[id]) {
                        is Trashed -> Result.success(TrashMove.TRASHED)
                        is Covered -> Result.success(TrashMove.WITH_FOLDER)
                        is BatchRefusal -> Result.failure(refused(answer))
                        else -> Result.failure(unanswered())
                    }
                    settle(index, outcome)
                    outcome.getOrNull()?.let { landed.add(id to it) }
                }
                landed += carried(landed.map { it.first }.toSet())
                if (landed.isNotEmpty()) {
                    moved(landed)
                    forget(landed.map { it.first })
                }
                continue
            }
        }
        sequential(ids).forEachIndexed { at, outcome ->
            settle(indexes[at], outcome)
            outcome.exceptionOrNull()?.let { if (stops(it)) stopped = it }
        }
        val carriedHere = carried(ids.filter { rootOutcome[it]?.isSuccess == true }.toSet())
        if (carriedHere.isNotEmpty()) {
            moved(carriedHere)
            forget(carriedHere.map { it.first })
        }
    }
    // Nested items whose folders all failed stay where they are, with their folder's reason.
    items.indices.filter { outcomes[it] == null }.forEach { index ->
        val reason = within[index].firstNotNullOfOrNull { rootOutcome[it]?.exceptionOrNull() } ?: unanswered()
        outcomes[index] = Result.failure(reason)
    }
    return outcomes.map { it!! }
}

/*
 * Undo for trashInBatches: puts back (id, workspace) pairs, in place. Folders go before what is in
 * them (`depth`: how many of the given items an item sits inside), since the server waits for a
 * folder in the same request but not in a later one; an item refused as `parent-trashed` is sent
 * again once the other requests have landed, for as long as that brings more back. One outcome per
 * item, in the order given; `back` hears each id as it lands. `sequential` as for trashInBatches.
 */
suspend fun restoreInBatches(
    items: List<Pair<String, String>>,
    depth: (id: String) -> Int,
    send: (workspaceId: String, ids: List<String>) -> List<BatchAnswer>,
    sequential: suspend (ids: List<String>) -> List<Result<Unit>>,
    back: (id: String) -> Unit = {},
): List<Result<Unit>> {
    val latest = HashMap<String, Result<Unit>>()
    val waiting = HashSet<String>()
    var stopped: Throwable? = null
    var perItem = false
    suspend fun pass(batch: List<Pair<String, String>>) {
        for ((workspace, chunk) in chunks(batch)) {
            coroutineContext.ensureActive()
            val ids = chunk.map { batch[it].first }
            // Sent again now: whatever this request says decides whether it waits once more.
            ids.forEach { waiting.remove(it) }
            stopped?.let { error -> ids.forEach { latest[it] = Result.failure(error) }; continue }
            if (!perItem) {
                val answers = try {
                    send(workspace, ids)
                } catch (error: BatchUnsupported) {
                    perItem = true
                    null
                } catch (error: Exception) {
                    error.rethrowIfCancelled()
                    ids.forEach { latest[it] = Result.failure(error) }
                    if (stops(error)) stopped = error
                    continue
                }
                if (answers != null) {
                    val byId = answers.associateBy { it.id }
                    for (id in ids) {
                        latest[id] = when (val answer = byId[id]) {
                            is Restored -> Result.success(Unit).also { back(id) }
                            is BatchRefusal -> Result.failure<Unit>(refused(answer)).also { if (answer.reason == "parent-trashed") waiting.add(id) }
                            else -> Result.failure<Unit>(unanswered())
                        }
                    }
                    continue
                }
            }
            sequential(ids).forEachIndexed { at, outcome ->
                latest[ids[at]] = outcome
                if (outcome.isSuccess) back(ids[at])
                outcome.exceptionOrNull()?.let { if (stops(it)) stopped = it }
            }
        }
    }
    pass(items.sortedBy { depth(it.first) })
    while (waiting.isNotEmpty() && stopped == null) {
        val again = items.filter { it.first in waiting }
        val before = latest.count { it.value.isSuccess }
        pass(again)
        if (latest.count { it.value.isSuccess } <= before) break
    }
    return items.map { latest.getValue(it.first) }
}

/*
 * A batch route's reply, read: the answers, or the error the whole request failed with. A server
 * without the route answers 501 `unsupported`, or a 404 that isn't the drive's own `not-found`
 * (one from before servers said `unsupported`): BatchUnsupported, so the caller falls back. A busy
 * workspace (409 `conflict`), the rate limit (429) and the body cap (413) are BatchRefused, in the
 * web's words, never retried here.
 */
fun batchAnswers(status: Int, text: String): List<BatchAnswer> {
    if (status == 401) throw NotAuthenticated()
    val body = runCatching { org.json.JSONObject(text) }.getOrNull()
    if (status !in 200..299) {
        val message = body?.optString("message")?.ifEmpty { null }
        val code = body?.optString("code")?.ifEmpty { null }
        when {
            status == 501 || (status == 404 && code != "not-found") -> throw BatchUnsupported()
            status == 404 -> throw NotFound(message ?: "This item no longer exists.")
            status == 409 && code == "conflict" -> throw BatchRefused(BatchRefused.Kind.BUSY)
            status == 429 -> throw BatchRefused(BatchRefused.Kind.TOO_MANY)
            status == 413 -> throw BatchRefused(BatchRefused.Kind.TOO_LARGE)
            else -> throw ApiError(status, message ?: "Request failed", code)
        }
    }
    // An answer that can't be read says nothing about what moved: unconfirmed, as no answer would be.
    val results = body?.optJSONArray("results") ?: throw unanswered()
    return (0 until results.length()).map { results.getJSONObject(it) }.map { item ->
        val id = item.getString("id")
        when (item.optString("status")) {
            "trashed" -> Trashed(id, item.optString("trashedAt"), item.optInt("changeSeq"))
            "covered" -> Covered(id, item.optString("by"))
            "restored" -> Restored(id, item.optInt("changeSeq"))
            else -> BatchRefusal(id, item.optString("reason"), item.optString("message").ifEmpty { "That didn’t move." })
        }
    }
}
