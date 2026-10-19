package com.hushos.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/* Set by a file picker's sign-in screen: Forgot your password sends the person to the app's own screen instead. */
val LocalRecoverInApp = compositionLocalOf<(() -> Unit)?> { null }

/*
 * When sign-in started from a file picker goes back to it: once the account is open on this phone, whether it was
 * opened here or in the app's own screen (a sign-in there, or a recovery, which always runs there), and only once no
 * recovery's new words wait to be seen and confirmed, here or there.
 */
object PickerReturn {
    fun ready(gate: Gate, recovery: DriveViewModel.RecoveryStep?, wordsUnsaved: Boolean): Boolean =
        gate == Gate.SIGNED_IN && recovery == null && !wordsUnsaved
}

/*
 * The app's own gate (sign-in, server address), and once PickerReturn says so, back to the picker. The activity asks
 * the view model to look at the session again on every resume (DriveViewModel.resumed), so a session stored by the
 * app's own screen opens the gate here too.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PickerSignIn(model: DriveViewModel, recoverInApp: () -> Unit, done: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val unsaved by com.hushos.app.data.RecoveryWords.unsaved.collectAsStateWithLifecycle()
    if (PickerReturn.ready(state.gate, model.recovery?.step, unsaved)) {
        LaunchedEffect(Unit) { done() }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        return
    }
    // Signed in by a recovery whose new words are still on the app's own screen: they are saved there first.
    if (state.gate == Gate.SIGNED_IN && unsaved) {
        Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
            EmptyState("Save your new recovery words", "They’re open in the HushOS app. Save them there, then come back here.") {
                Button(onClick = recoverInApp) { Text("Open HushOS") }
            }
        }
        return
    }
    CompositionLocalProvider(LocalRecoverInApp provides recoverInApp) { HushOSApp(model) }
}
