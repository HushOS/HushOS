package com.hushos.app.ui

import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.Problems

/* Why the rest stayed where they were, in words of our own: the server's sentence is never shown here. */
enum class TrashFailure { OFFLINE, SIGNED_OUT, OTHER }

fun trashFailure(error: Throwable): TrashFailure = when {
    error is NotAuthenticated -> TrashFailure.SIGNED_OUT
    Problems.offline(error) -> TrashFailure.OFFLINE
    else -> TrashFailure.OTHER
}

class TrashResult(val tried: List<Opened>, val moved: List<Opened>, val failed: List<Pair<Opened, Throwable>>) {
    /* The folders whose listings changed: each read once after the batch, never once per item. */
    val folders: Set<String> get() = moved.mapNotNull { it.node.parentId }.toSet()

    /* The reason the notice gives: offline only when every failure was, signed out when any was. */
    val failure: TrashFailure?
        get() {
            if (failed.isEmpty()) return null
            val kinds = failed.map { trashFailure(it.second) }
            return when {
                TrashFailure.SIGNED_OUT in kinds -> TrashFailure.SIGNED_OUT
                kinds.all { it == TrashFailure.OFFLINE } -> TrashFailure.OFFLINE
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
            TrashFailure.SIGNED_OUT -> "Sign in again, then try again."
            TrashFailure.OTHER -> "Try again."
        }
        return "${moved.size} of ${tried.size} moved to Trash. " + when (failure) {
            TrashFailure.OFFLINE -> "You’re offline, so the rest weren’t confirmed."
            TrashFailure.SIGNED_OUT -> "Sign in again to move the rest."
            TrashFailure.OTHER -> "The rest stayed where they were. Try again."
        }
    }
}

class TrashSteps(
    /*
     * The whole batch in one call (Vault.trashMany): one outcome per item, in order, and `moved`
     * told of each item the moment the server confirms it.
     */
    val send: suspend (items: List<Opened>, moved: (Opened) -> Unit) -> List<Result<Unit>>,
    /* Takes one confirmed row off every list, as soon as the server confirms it. */
    val drop: (Opened) -> Unit,
    /* The notice; `undo` brings back exactly what moved, and is null when nothing did. */
    val announce: (text: String, undo: (() -> Unit)?) -> Unit,
    /* What the notice's Undo runs, with exactly the items that moved. */
    val restore: (moved: List<Opened>) -> Unit,
    /* The feed, the listings and the system's view, once for the batch and in the background. */
    val settle: (folders: Set<String>) -> Unit,
)

/*
 * Move to Trash for one item or many: each row leaves the lists as the server confirms it; after
 * the last answer come the notice and one follow-up that runs on its own. A follow-up that fails
 * leaves the lists as they are: the rows were taken off from the server's answers, not from a listing.
 */
suspend fun trashMany(items: List<Opened>, steps: TrashSteps): TrashResult {
    val outcomes = steps.send(items) { steps.drop(it) }
    check(outcomes.size == items.size) { "One outcome per item" }
    val moved = items.filterIndexed { index, _ -> outcomes[index].isSuccess }
    val failed = items.mapIndexedNotNull { index, item -> outcomes[index].exceptionOrNull()?.let { item to it } }
    val result = TrashResult(items, moved, failed)
    result.notice()?.let { text -> steps.announce(text, if (moved.isEmpty()) null else ({ steps.restore(moved) })) }
    if (moved.isNotEmpty()) steps.settle(result.folders)
    return result
}
