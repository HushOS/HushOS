package com.hushos.app.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/*
 * A recovery's new words, once per process. Recovery stores a session before it shows the new words, and it runs in
 * the app's own screen even when it began from a file picker's sign-in, so the picker's screen asks here whether
 * words are still waiting to be seen and confirmed before it goes back to the picker.
 */
object RecoveryWords {
    private val waiting = MutableStateFlow(false)
    val unsaved: StateFlow<Boolean> = waiting

    /* A recovery is about to store a session whose new words haven't been seen yet. */
    fun begun() { waiting.value = true }

    /* The words were shown and confirmed, or the recovery failed or was left. */
    fun settled() { waiting.value = false }
}
