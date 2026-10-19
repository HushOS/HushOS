package com.hushos.app.data

import java.io.IOException

/*
 * The last step of an upload: complete it, or release its reservation. An upload that is never completed holds its
 * reserved bytes until it expires, so a failed complete left a large file's room taken and the next upload was refused
 * as out of room. Abort releases it at once, on any definite answer from the server: a refusal (400), a conflict the
 * server kept "for attach or abort" (409: Android never attaches, so only an abort gives that room back), an upload
 * already cancelled or expired (harmless). The server refuses to abort one that is completing or completed, so a
 * definite answer can't undo a finished upload.
 *
 * When the outcome is unknown (no network, a dropped connection, a timeout, 429, a 5xx) the complete may have landed,
 * so it is asked again: the server answers a repeated complete with the finished node. Still unknown after a few tries,
 * the upload is left to expire rather than aborted blind.
 */
object UploadFinish {
    const val ATTEMPTS = 4

    /* No answer, or one that doesn't say what happened: the complete may have landed. */
    fun unknown(error: Throwable): Boolean = error is Unreachable || error is IOException ||
        (error is ApiError && (error.status == 0 || error.status == 408 || error.status == 429 || error.status >= 500))

    /* The server answered, and the answer says the complete didn't land: every ApiError but a timeout, 429 or 5xx. */
    fun definite(error: Throwable): Boolean =
        error is ApiError && error.status in 400..499 && error.status != 408 && error.status != 429

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
                if (definite(error)) abort()
                throw error
            }
        }
    }
}
