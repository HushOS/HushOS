package com.hushos.app.data

/*
 * One request per item, one after another; one outcome per item, in the items' order. After a
 * failure every later request would share (no network, the session ended) the rest are not sent
 * and carry that failure: a dozen timeouts in a row would only keep the person waiting.
 */
fun <T, R> oneAfterAnother(items: List<T>, send: (T) -> R): List<Result<R>> {
    val outcomes = ArrayList<Result<R>>(items.size)
    var stopped: Throwable? = null
    for (item in items) {
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
