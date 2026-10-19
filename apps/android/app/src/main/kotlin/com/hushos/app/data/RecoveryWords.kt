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
 * Only this phone's own recovery holds the picker, and only for the account it recovered: the marker holds that
 * account's user id, and anyone else signed in finds it cleared. Sign-out, account removal and another account signing
 * in clear it too (AccountStore). An account that simply never confirmed its kit isn't stopped at the picker for it.
 */
object RecoveryWords {
    private var marker: RecoveryMarker? = null
    private val waiting = MutableStateFlow<String?>(null)
    /* The user id whose recovery here waits for its words to be confirmed, or null. */
    val waitingFor: StateFlow<String?> = waiting

    /* At start-up: picks up a recovery the app was stopped in the middle of. */
    fun load(context: Context) = use(RecoveryMarker(File(context.filesDir, RecoveryMarker.FILE)))

    /* The marker's file (load does this; a test passes its own). */
    fun use(found: RecoveryMarker) {
        marker = found
        waiting.value = found.owner()
    }

    /* `userId`'s recovery is about to store a session whose new words haven't been seen yet. */
    fun begun(userId: String) { marker?.set(userId); waiting.value = userId }

    /* The words were shown and confirmed, or the recovery failed or was left, or the server has nothing waiting. */
    fun settled() { marker?.clear(); waiting.value = null }

    /*
     * Whether `userId` (the account signed in now) has a recovery here waiting for its words. A marker left for another
     * account is cleared: it holds nobody else.
     */
    fun waitingFor(userId: String?): Boolean {
        val owner = waiting.value ?: return false
        if (userId != null && owner.equals(userId, ignoreCase = true)) return true
        settled()
        return false
    }

    /* Another account is about to own the phone's data (or nobody, on sign-out): a marker for someone else goes. */
    fun keepOnlyFor(userId: String?) {
        val owner = waiting.value ?: return
        if (userId == null || !owner.equals(userId, ignoreCase = true)) settled()
    }

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

/* The marker's file: present, holding the recovered account's user id, while its new words wait to be confirmed. */
class RecoveryMarker(private val file: File) {
    fun owner(): String? = runCatching { file.takeIf { it.exists() }?.readText()?.trim()?.ifEmpty { null } }.getOrNull()

    fun set(userId: String) {
        runCatching { file.parentFile?.mkdirs(); file.writeText(userId) }
    }

    fun clear() {
        file.delete()
    }

    companion object {
        const val FILE = "recovery-words-unsaved"
    }
}
