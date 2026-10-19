package com.hushos.app.data

import android.content.Context
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/*
 * A recovery on this phone whose new words aren't confirmed yet. Recovery stores a session before it shows the new
 * words, and it runs in the app's own screen even when it began from a file picker's sign-in, so the picker's screen
 * asks here (and then the server) before it goes back to the picker. Kept in a file, so it outlives the app being
 * stopped while the words are on screen; not an account file (AccountStore leaves it), since a recovery into another
 * account than the one on the phone wipes those as it signs in.
 *
 * Only this phone's own recovery holds the picker: an account that simply never confirmed its kit (a new one, or one
 * whose keys were replaced) is not stopped at the picker for it.
 */
object RecoveryWords {
    private var marker: RecoveryMarker? = null
    private val waiting = MutableStateFlow(false)
    val unsaved: StateFlow<Boolean> = waiting

    /* At start-up: picks up a recovery the app was stopped in the middle of. */
    fun load(context: Context) {
        val found = RecoveryMarker(File(context.filesDir, RecoveryMarker.FILE))
        marker = found
        waiting.value = found.get()
    }

    /* A recovery is about to store a session whose new words haven't been seen yet. */
    fun begun() { marker?.set(true); waiting.value = true }

    /* The words were shown and confirmed, or the recovery failed or was left, or the server has nothing waiting. */
    fun settled() { marker?.set(false); waiting.value = false }

    /*
     * The server's answer to "are this account's words confirmed?" (recoveryBackup): true when they wait, false when
     * confirmed or when the account has no words at all, null for anything else (no network, a 5xx, a refusal): an
     * answer that isn't one must never release the picker or clear the marker.
     */
    fun answer(result: Result<Boolean>): Boolean? = result.fold(
        onSuccess = { confirmed -> !confirmed },
        onFailure = { error -> if (error is NoRecoveryKey) false else null },
    )
}

/* The marker's file: present while a recovery on this phone waits for its words to be confirmed. */
class RecoveryMarker(private val file: File) {
    fun get(): Boolean = file.exists()

    fun set(waiting: Boolean) {
        if (waiting) runCatching { file.parentFile?.mkdirs(); file.writeText("") } else file.delete()
    }

    companion object {
        const val FILE = "recovery-words-unsaved"
    }
}
