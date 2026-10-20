package com.hushos.app.data

import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive

/*
 * One request per item, one after another; one outcome per item, in the items' order. After a
 * failure every later request would share (no network, the session ended) the rest are not sent
 * and carry that failure: a dozen timeouts in a row would only keep the person waiting. The
 * requests block, so cancellation is looked at between items: a screen that went away stops the
 * batch at the next item instead of after the last.
 */
suspend fun <T, R> oneAfterAnother(items: List<T>, send: (T) -> R): List<Result<R>> {
    val outcomes = ArrayList<Result<R>>(items.size)
    var stopped: Throwable? = null
    for (item in items) {
        coroutineContext.ensureActive()
        stopped?.let { outcomes.add(Result.failure(it)); continue }
        try {
            outcomes.add(Result.success(send(item)))
        } catch (error: Exception) {
            error.rethrowIfCancelled()
            outcomes.add(Result.failure(error))
            if (error is NotAuthenticated || Problems.offline(error)) stopped = error
        }
    }
    return outcomes
}

/*
 * Vault.trashMany's body: each item trashed, and `moved` told of it only once its trash came back.
 * Telling first would take a row off the lists that the server then refused to move.
 */
suspend fun trashEach(ids: List<String>, trash: (String) -> Unit, moved: (String) -> Unit): List<Result<Unit>> =
    oneAfterAnother(ids) { trash(it); moved(it) }
