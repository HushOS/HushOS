package com.hushos.app.data

/*
 * What went wrong, in the words iOS and the web use: a short title and a sentence saying what to do.
 * Nothing in it is an exception's own text: that is written for developers (a core error, a parser,
 * "The coroutine was canceled because it left the composition") and goes to the log, never on screen.
 */
data class Problem(val title: String, val body: String)

object Problems {
    const val OFFLINE = "We couldn’t reach HushOS. Check your connection, then try again."
    const val SERVER = "Something went wrong on HushOS. Try again in a moment."
    const val ROOM = "This doesn’t fit in your storage. Free up space to upload it."

    fun of(error: Throwable): Problem {
        val raw = error.message?.takeIf { it.isNotBlank() }
        return when {
            offline(error) || error is java.io.IOException -> Problem("You’re offline", OFFLINE)
            error is NotAuthenticated -> Problem("You’ve been signed out", "Sign in again to carry on.")
            // Account calls fail with the app's own sentence (a sign-in refused, a reply missing a field).
            error is AuthFailure -> raw?.let { Problem("That didn’t work", it) } ?: GENERIC
            // Refusals carry a sentence the app wrote (a later format, an old link, older settings): said as written.
            error is Refused -> Problem(error.title, raw ?: SERVER)
            error is NotFound -> GONE
            error is ApiError -> when {
                error.status == 404 || error.status == 410 -> GONE
                error.status == 402 || error.status == 413 || error.status == 507 || roomy(raw) -> Problem("Not enough room", ROOM)
                error.status == 403 -> Problem("You can’t do that here", "You don’t have permission for this. Ask whoever shared it.")
                error.status == 409 -> Problem("Something changed", "It was changed somewhere else in the meantime. Try again.")
                error.status == 429 -> Problem("Too many tries", "Wait a moment, then try again.")
                error.status >= 500 -> Problem("HushOS had a problem", SERVER)
                else -> GENERIC
            }
            else -> GENERIC
        }
    }

    /* No network, however the call said it: Auth's calls throw AuthFailure(UNREACHABLE) where the drive's throw Unreachable. */
    fun offline(error: Throwable): Boolean = error is Unreachable || (error is AuthFailure && error.message == Auth.UNREACHABLE)

    /*
     * One sentence for a line under a field or a notice: the alert's sentence for what is known, and
     * `fallback` (what this screen was doing, in its words) for anything else. An AuthFailure is the
     * app's own sentence, or the server's chosen by signIn, so it is said as written.
     */
    fun say(error: Throwable, fallback: String): String = of(error).let { if (it == GENERIC) fallback else it.body }

    private val GONE = Problem("It’s no longer here", "It was moved, deleted, or isn’t shared with you any more.")
    private val GENERIC = Problem("That didn’t work", "Try again. If it keeps happening, sign out and back in.")

    private fun roomy(message: String?) = message != null && listOf("quota", "storage is full", "not enough room", "not enough space").any { message.contains(it, ignoreCase = true) }

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
