package com.hushos.app.data

/*
 * The decisions behind kept folders, apart from storage and the network so a test can
 * hold them: when a file that failed is tried again, what a failure means for the
 * folder's job, what the folder row says, and which kept folders lose their share.
 */

/* A file in a kept folder that couldn't be kept: why, how often, and when it is tried next. */
data class KeepFailure(val fileId: String, val folderId: String, val name: String, val reason: String, val attempts: Int, val nextAt: Long)

object KeepRules {
    /* The first wait after a failure, doubling each time up to `LONGEST`. */
    const val FIRST_WAIT = 60_000L
    const val LONGEST_WAIT = 6 * 60 * 60_000L

    /* Whether a file is tried in this run: never failed, its wait is over, or the person asked to retry. */
    fun due(failure: KeepFailure?, now: Long): Boolean = failure == null || now >= failure.nextAt

    /* After another failure: one more attempt counted, and a longer wait before the next. */
    fun failed(previous: KeepFailure?, fileId: String, folderId: String, name: String, reason: String, now: Long): KeepFailure {
        val attempts = (previous?.attempts ?: 0) + 1
        val wait = (FIRST_WAIT shl (attempts - 1).coerceAtMost(20)).coerceAtMost(LONGEST_WAIT)
        return KeepFailure(fileId, folderId, name, reason, attempts, now + wait)
    }

    /* Retry, asked for: tried in the next run, the count kept so a further failure still waits longer. */
    fun retryNow(failure: KeepFailure): KeepFailure = failure.copy(nextAt = 0L)

    /*
     * What a file's error means for the folder's job. No network or no session fails the
     * whole job (WorkManager tries it again with its own backoff); anything else belongs to
     * that file, and the rest of the folder is kept.
     */
    fun failsTheJob(error: Exception): Boolean = error is Unreachable || error is NotAuthenticated

    /* The folder row's line when some of its files couldn't be kept. */
    fun folderLine(failures: Int): String? = when (failures) {
        0 -> null
        1 -> "1 file couldn’t be kept"
        else -> "$failures files couldn’t be kept"
    }

    /*
     * Kept folders whose share stopped: a folder kept out of a share whose root is no longer
     * among the shares this account receives. Only a list the server just sent counts;
     * an unreachable server proves nothing and removes nothing.
     */
    fun unshared(kept: List<Offline.Folder>, receivedRoots: Set<String>): List<Offline.Folder> =
        kept.filter { it.shareRoot != null && it.shareRoot !in receivedRoots }
}
