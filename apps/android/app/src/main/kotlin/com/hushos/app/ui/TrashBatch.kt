package com.hushos.app.ui

import com.hushos.app.data.ApiError
import com.hushos.app.data.BatchRefused
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.Problems
import com.hushos.app.data.TrashItem
import com.hushos.app.data.TrashMove

/*
 * Why the rest didn't move, in words of our own: the server's sentence is never shown here.
 * UNCONFIRMED is a gateway's 502 or 504, or an item a batch's answer left out: the request may
 * have landed, as it may have when there was no answer at all, so neither is ever said to have
 * "stayed". BUSY, TOO_MANY and TOO_LARGE refused a whole batch request before anything moved.
 * ALREADY_TRASHED is an item the server refused as in the trash already (itself or through a
 * folder): it didn't move, but it didn't stay where it was either.
 */
enum class TrashFailure { OFFLINE, UNCONFIRMED, SIGNED_OUT, BUSY, TOO_MANY, TOO_LARGE, ALREADY_TRASHED, OTHER }

fun trashFailure(error: Throwable): TrashFailure = when {
    error is NotAuthenticated -> TrashFailure.SIGNED_OUT
    Problems.offline(error) -> TrashFailure.OFFLINE
    error is ApiError && (error.status == 502 || error.status == 504) -> TrashFailure.UNCONFIRMED
    error is BatchRefused -> when (error.kind) {
        BatchRefused.Kind.BUSY -> TrashFailure.BUSY
        BatchRefused.Kind.TOO_MANY -> TrashFailure.TOO_MANY
        BatchRefused.Kind.TOO_LARGE -> TrashFailure.TOO_LARGE
    }
    error is ApiError && error.code == "trashed" -> TrashFailure.ALREADY_TRASHED
    else -> TrashFailure.OTHER
}

/* The words for a whole request refused, the web's. */
private fun refusedWords(failure: TrashFailure): String? = when (failure) {
    TrashFailure.BUSY -> BatchRefused.Kind.BUSY.words
    TrashFailure.TOO_MANY -> BatchRefused.Kind.TOO_MANY.words
    TrashFailure.TOO_LARGE -> BatchRefused.Kind.TOO_LARGE.words
    else -> null
}

/*
 * `moved` is every item now in the trash, those that went with a folder included: what the count
 * says. `undoable` is what reached the trash on its own, exactly what Undo puts back (the rest
 * come back with their folders).
 */
class TrashResult(val tried: List<Opened>, val moved: List<Opened>, val failed: List<Pair<Opened, Throwable>>, val undoable: List<Opened> = moved) {
    /*
     * What the server said was in the trash already: not moved, but not where the list shows it
     * either (another device trashed it), so its row leaves the lists too.
     */
    val alreadyTrashed: List<Opened> get() = failed.filter { trashFailure(it.second) == TrashFailure.ALREADY_TRASHED }.map { it.first }

    /* The folders whose listings changed: each read once after the batch, never once per item. */
    val folders: Set<String> get() = (moved + alreadyTrashed).mapNotNull { it.node.parentId }.toSet()

    /*
     * The reason the notice gives: signed out when any was; offline only when every failure was;
     * unconfirmed when any may have landed (offline, a gateway error, an item left unanswered); a
     * whole request refused (busy, too many, too large) next; otherwise a refusal.
     */
    val failure: TrashFailure?
        get() {
            if (failed.isEmpty()) return null
            val kinds = failed.map { trashFailure(it.second) }
            return when {
                TrashFailure.SIGNED_OUT in kinds -> TrashFailure.SIGNED_OUT
                kinds.all { it == TrashFailure.OFFLINE } -> TrashFailure.OFFLINE
                kinds.any { it == TrashFailure.OFFLINE || it == TrashFailure.UNCONFIRMED } -> TrashFailure.UNCONFIRMED
                TrashFailure.BUSY in kinds -> TrashFailure.BUSY
                TrashFailure.TOO_MANY in kinds -> TrashFailure.TOO_MANY
                TrashFailure.TOO_LARGE in kinds -> TrashFailure.TOO_LARGE
                kinds.all { it == TrashFailure.ALREADY_TRASHED } -> TrashFailure.ALREADY_TRASHED
                else -> TrashFailure.OTHER
            }
        }

    /*
     * What the notice says: only what moved is counted. Null when the one item asked for failed,
     * whose error is shown the way a single write's always was (the alert, or the offline line).
     * Without an answer a request may still have landed, so offline says "weren't confirmed",
     * never "stayed": the next sync takes off any row the server did move.
     */
    fun notice(): String? {
        val failure = failure
        if (failure == null) return if (moved.size == 1) "Moved “${moved[0].name}” to Trash" else "Moved ${moved.size} items to Trash"
        if (tried.size == 1) return null
        if (moved.isEmpty()) return "Couldn’t move to Trash. " + when (failure) {
            TrashFailure.OFFLINE -> "You’re offline. Try again once you’re connected."
            TrashFailure.UNCONFIRMED -> "HushOS didn’t confirm it. Try again."
            TrashFailure.SIGNED_OUT -> "Sign in again, then try again."
            TrashFailure.OTHER -> "Try again."
            TrashFailure.ALREADY_TRASHED -> "They’re in Trash already."
            else -> refusedWords(failure)!!
        }
        return "${moved.size} of ${tried.size} moved to Trash. " + when (failure) {
            TrashFailure.OFFLINE -> "You’re offline, so the rest weren’t confirmed."
            TrashFailure.UNCONFIRMED -> "The rest weren’t confirmed. Try again."
            TrashFailure.SIGNED_OUT -> "Sign in again to move the rest."
            TrashFailure.OTHER -> "The rest stayed where they were. Try again."
            TrashFailure.ALREADY_TRASHED -> "The rest were in Trash already."
            else -> refusedWords(failure)!!
        }
    }
}

class TrashSteps(
    /*
     * The whole batch in one call (Vault.trashMany): one outcome per item, in order (how it went, or
     * why not), and `moved` told of what a request moved the moment its answer lands.
     */
    val send: suspend (items: List<Opened>, moved: (List<Opened>) -> Unit) -> List<Result<TrashMove>>,
    /* Takes confirmed rows off every list, a request's worth at once as its answer lands. */
    val drop: (List<Opened>) -> Unit,
    /* The notice; `undo` brings back exactly what went on its own, and is null when nothing did. */
    val announce: (text: String, undo: (() -> Unit)?) -> Unit,
    /* What the notice's Undo runs, with exactly the items that went on their own. */
    val restore: (moved: List<Opened>) -> Unit,
    /* The feed, the listings and the system's view, once for the batch and in the background. */
    val settle: (folders: Set<String>) -> Unit,
)

/*
 * Move to Trash for one item or many: each row leaves the lists as its request's answer lands; after
 * the last answer come the notice and one follow-up that runs on its own. A follow-up that fails
 * leaves the lists as they are: the rows were taken off from the server's answers, not from a listing.
 */
suspend fun trashMany(items: List<Opened>, steps: TrashSteps): TrashResult {
    val outcomes = steps.send(items) { steps.drop(it) }
    check(outcomes.size == items.size) { "One outcome per item" }
    val moved = items.filterIndexed { index, _ -> outcomes[index].isSuccess }
    val undoable = items.filterIndexed { index, _ -> outcomes[index].getOrNull() == TrashMove.TRASHED }
    val failed = items.mapIndexedNotNull { index, item -> outcomes[index].exceptionOrNull()?.let { item to it } }
    val result = TrashResult(items, moved, failed, undoable)
    // In the trash already (trashed elsewhere): the row goes as a moved one would, and its folder is read again.
    val elsewhere = result.alreadyTrashed
    if (elsewhere.isNotEmpty()) steps.drop(elsewhere)
    result.notice()?.let { text -> steps.announce(text, if (undoable.isEmpty()) null else ({ steps.restore(undoable) })) }
    if (moved.isNotEmpty() || elsewhere.isNotEmpty()) steps.settle(result.folders)
    return result
}

/*
 * After the notice's Undo: each row that came back goes into its folder's list, if that folder is
 * on screen, once, in list order (folders first, then by name); rows that didn't come back stay
 * out. Every row that came back leaves the Trash list, which may be open under the notice.
 */
fun afterUndo(folders: Map<String, List<Opened>>, trash: List<TrashItem>, back: List<Opened>): Pair<Map<String, List<Opened>>, List<TrashItem>> {
    val byName = compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }
    val backIds = back.map { it.id }.toSet()
    val rows = folders.mapValues { (id, rows) ->
        val returning = back.filter { item -> item.node.parentId == id && rows.none { it.id == item.id } }
        if (returning.isEmpty()) rows else (rows + returning).sortedWith(byName)
    }
    return rows to trash.filter { it.item.id !in backIds }
}

/* What an Undo of many says when not everything came back; null when it all did, or for one item (its error says it). */
fun undoProblem(back: Int, tried: Int, errors: List<Throwable> = emptyList()): String? {
    if (tried <= 1 || back == tried) return null
    // A whole request turned away says why, in the web's words; the rest are still in Trash.
    val refused = errors.firstNotNullOfOrNull { (it as? BatchRefused)?.kind?.words }
    val count = if (back == 0) "Couldn’t bring them back. " else "$back of $tried are back. "
    return when {
        refused != null -> count + refused + " The rest are still in Trash."
        back == 0 -> count + "They’re still in Trash."
        else -> count + "The rest are still in Trash."
    }
}
