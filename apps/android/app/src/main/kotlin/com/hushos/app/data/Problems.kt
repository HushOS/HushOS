package com.hushos.app.data

/*
 * What went wrong, in the words iOS and the web use: a short title, a sentence saying what
 * to do, and the raw detail (the server's own message, or the error's) kept for a Details
 * expander only. The alert never leads with the raw text.
 */
data class Problem(val title: String, val body: String, val detail: String? = null)

object Problems {
    const val OFFLINE = "We couldn’t reach HushOS. Check your connection, then try again."
    const val SERVER = "Something went wrong on HushOS. Try again in a moment."

    fun of(error: Throwable): Problem {
        val raw = error.message?.takeIf { it.isNotBlank() }
        return when {
            error is Unreachable || error is java.io.IOException -> Problem("You’re offline", OFFLINE)
            error is NotAuthenticated -> Problem("You’ve been signed out", "Sign in again to carry on.")
            error is NotFound -> Problem("It’s no longer here", "It was moved, deleted, or isn’t shared with you any more.", raw)
            error is ApiError -> when {
                error.status == 404 || error.status == 410 -> Problem("It’s no longer here", "It was moved, deleted, or isn’t shared with you any more.", raw)
                error.status == 413 || error.status == 507 || roomy(raw) -> Problem("Not enough room", "This doesn’t fit in your storage. Free up space to upload it.", raw)
                error.status == 403 -> Problem("You can’t do that here", "You don’t have permission for this. Ask whoever shared it.", raw)
                error.status == 409 -> Problem("Something changed", "It was changed somewhere else in the meantime. Try again.", raw)
                error.status == 429 -> Problem("Too many tries", "Wait a moment, then try again.", raw)
                error.status >= 500 -> Problem("HushOS had a problem", SERVER, raw)
                else -> generic(raw)
            }
            else -> generic(raw)
        }
    }

    private fun roomy(message: String?) = message != null && listOf("quota", "storage is full", "not enough room", "not enough space").any { message.contains(it, ignoreCase = true) }

    private fun generic(raw: String?) = Problem("That didn’t work", "Try again. If it keeps happening, sign out and back in.", raw)

    /*
     * Sign-in's words for a failed request: the server's own sentence when it sends one (it is
     * written for people), otherwise one that says what happened, as iOS's sign-in does.
     */
    fun signIn(status: Int, serverMessage: String?): String = serverMessage?.takeIf { it.isNotBlank() } ?: when {
        status == 429 -> "Too many tries. Wait a moment, then try again."
        status == 401 || status == 403 -> "That email and password don’t match. Check them and try again."
        status >= 500 -> SERVER
        else -> "HushOS didn’t answer as expected. Try again in a moment."
    }
}
