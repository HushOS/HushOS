package com.hushos.app.data

import java.io.IOException

/*
 * The last step of an upload: complete it, or release its reservation. An upload that is never completed holds its
 * reserved bytes until it expires, so a failed complete left a large file's room taken and the next upload was refused
 * as out of room. Abort releases it at once, but only when the server's answer leaves no doubt that the upload did not
 * finish.
 *
 * When the outcome is unknown (no network, a dropped connection, a timeout, a 5xx) the complete may have landed, so it
 * is asked again: the server answers a repeated complete with the finished node. Still unknown after a few tries, the
 * upload is left to expire rather than aborted blind. (The server also refuses to abort an upload that is completing
 * or completed; this never relies on that.)
 */
object UploadFinish {
    const val ATTEMPTS = 4

    /* No answer, or one that doesn't say what happened: the complete may have landed. */
    fun unknown(error: Throwable): Boolean = error is Unreachable || error is IOException ||
        (error is ApiError && (error.status == 0 || error.status == 408 || error.status == 429 || error.status >= 500))

    /*
     * The server refused the complete, so the upload is still open: worth aborting. Not 404 (nothing to abort) and not
     * 409 (cancelled, expired, or a conflict the server has already settled and released).
     */
    fun refused(error: Throwable): Boolean =
        error is ApiError && error.status in 400..499 && error.status !in setOf(404, 408, 409, 429)

    fun <T> complete(complete: () -> T, abort: () -> Unit, sleep: (Long) -> Unit = Thread::sleep): T {
        var attempt = 0
        while (true) {
            try {
                return complete()
            } catch (error: Exception) {
                attempt++
                if (unknown(error) && attempt < ATTEMPTS) {
                    sleep(1_000L shl (attempt - 1))
                    continue
                }
                if (refused(error)) abort()
                throw error
            }
        }
    }
}
