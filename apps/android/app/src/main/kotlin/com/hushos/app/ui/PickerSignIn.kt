package com.hushos.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle

/* Set by a file picker's sign-in screen: Forgot your password sends the person to the app's own screen instead. */
val LocalRecoverInApp = compositionLocalOf<(() -> Unit)?> { null }

/*
 * When sign-in started from a file picker goes back to it: once the account is open on this phone, whether it was
 * opened here or in the app's own screen (a sign-in there, or a recovery, which always runs there), and, after a
 * recovery on this phone, only once its new words are confirmed as saved.
 *
 * Only this phone's own recovery holds (`localUnsaved`, RecoveryWords: kept in a file, so it outlives the app being
 * stopped with the words on screen). An account that never confirmed its kit for another reason (a new account, keys
 * replaced) goes straight back: the picker is for picking a file, not a place to be stopped for a reminder. While the
 * marker is set, the server's answer (`words`, asked on every resume) decides: confirmed releases the picker and
 * clears the marker; waiting, or no answer, holds, with Open HushOS leading to the words and their check.
 */
object PickerReturn {
    enum class Words { CHECKING, UNSAVED, SAVED, UNKNOWN }

    fun ready(gate: Gate, recovery: DriveViewModel.RecoveryStep?, words: Words, localUnsaved: Boolean): Boolean =
        gate == Gate.SIGNED_IN && recovery == null && (!localUnsaved || words == Words.SAVED)

    /* "Save your recovery words" rather than the app: signed in after this phone's recovery, its words not confirmed. */
    fun holding(gate: Gate, words: Words, localUnsaved: Boolean): Boolean =
        gate == Gate.SIGNED_IN && localUnsaved && (words == Words.UNSAVED || words == Words.UNKNOWN)

    fun words(unsaved: Boolean?): Words = when (unsaved) {
        true -> Words.UNSAVED
        false -> Words.SAVED
        null -> Words.UNKNOWN
    }
}

/*
 * The app's own gate (sign-in, server address), and once PickerReturn says so, back to the picker. The activity asks
 * the view model to look at the session again on every resume (DriveViewModel.resumed), so a session stored by the
 * app's own screen opens the gate here too.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PickerSignIn(model: DriveViewModel, recoverInApp: () -> Unit, showWords: () -> Unit, done: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val localUnsaved by com.hushos.app.data.RecoveryWords.unsaved.collectAsStateWithLifecycle()
    var words by remember { mutableStateOf(PickerReturn.Words.CHECKING) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.gate) {
        if (state.gate != Gate.SIGNED_IN) return@LaunchedEffect
        // Asked again on every resume: the words are confirmed in the app's own screen, then the person comes back.
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            words = PickerReturn.words(model.recoveryWordsUnsaved())
            // Nothing waits on the server: a flag left by a recovery that never showed its words is stale.
            if (words == PickerReturn.Words.SAVED) com.hushos.app.data.RecoveryWords.settled()
        }
    }
    when {
        PickerReturn.ready(state.gate, model.recovery?.step, words, localUnsaved) -> {
            LaunchedEffect(Unit) { done() }
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        }
        PickerReturn.holding(state.gate, words, localUnsaved) -> Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
            EmptyState("Save your recovery words", "Save them in the HushOS app, then come back here.") {
                Button(onClick = showWords) { Text("Open HushOS") }
            }
        }
        state.gate == Gate.SIGNED_IN -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        else -> CompositionLocalProvider(LocalRecoverInApp provides recoverInApp) { HushOSApp(model) }
    }
}
