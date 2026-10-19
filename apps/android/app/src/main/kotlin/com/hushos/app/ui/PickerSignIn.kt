package com.hushos.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/*
 * When sign-in started from a file picker is done: the account is open and nothing of the app's own is still on
 * screen. A recovery shows the new twelve words signed in, and they must be seen and saved before going back.
 */
object PickerReturn {
    fun ready(gate: Gate, recovery: DriveViewModel.RecoveryStep?): Boolean = gate == Gate.SIGNED_IN && recovery == null
}

/* The app's own gate (sign-in, server address, recovery), and once PickerReturn says so, back to the picker. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PickerSignIn(model: DriveViewModel, done: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    if (PickerReturn.ready(state.gate, model.recovery?.step)) {
        LaunchedEffect(Unit) { done() }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        return
    }
    HushOSApp(model)
}
