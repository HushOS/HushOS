package com.hushos.app.data

import kotlin.coroutines.cancellation.CancellationException

/*
 * runCatching for code that suspends. runCatching catches CancellationException too, so work cancelled
 * because its screen went away (a LaunchedEffect restarting, a rememberCoroutineScope leaving the
 * composition, a lifecycle stopping) came back as a failure and was shown as "That didn't work".
 * Cancellation is not a failure: it is thrown on, so the coroutine ends quietly as it was asked to.
 *
 * Use it wherever the block suspends (withContext, a suspend call). A block that only blocks never sees a
 * coroutine's cancellation, and there plain runCatching is fine.
 */
inline fun <T> attempt(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Throwable) {
    Result.failure(error)
}

/* For a catch (error: Exception) around suspending code: cancellation goes on its way, anything else stays. */
fun Throwable.rethrowIfCancelled() {
    if (this is CancellationException) throw this
}
