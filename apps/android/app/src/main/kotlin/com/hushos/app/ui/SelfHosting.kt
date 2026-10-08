package com.hushos.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.hushos.app.BuildConfig
import com.hushos.app.data.ServerAddress
import com.hushos.tokens.AlpineSpace

/*
 * Self-hosting › Server address: which HushOS this phone signs in to, changed only before
 * signing in (from sign-in's gear). Signed in, it shows the address read-only and says how to
 * change it (Account › Advanced). A custom address changes where the app signs in; links still
 * open only for the server signed in to (AppLinks compares against it).
 */
@Composable
fun SelfHostingScreen(model: DriveViewModel, state: DriveState, signedIn: Boolean, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var draft by rememberSaveable { mutableStateOf(state.origin) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(onBack = onBack)
    fun save() {
        when (val check = ServerAddress.check(draft, allowLocalHttp = BuildConfig.DEBUG)) {
            is ServerAddress.Check.Ok -> { model.setOrigin(check.origin); onBack() }
            is ServerAddress.Check.Invalid -> error = check.reason
        }
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
        DestinationBar("Self-hosting", onBack = onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            OutlinedTextField(
                value = if (signedIn) state.origin else draft, onValueChange = { draft = it; error = null }, label = { Text("Server address") },
                placeholder = { Text("https://hush.example.org") }, singleLine = true, enabled = !signedIn, isError = error != null,
                supportingText = (error ?: if (signedIn) "Sign out to change it" else null)?.let { { Text(it) } },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (!signedIn) save() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Use this only if you or your organisation runs your own HushOS server.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            if (!signedIn) {
                TextButton(onClick = { draft = ServerAddress.HUSHOS; error = null }) { Text("Use hushos.com") }
                Button(onClick = ::save, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Save") }
            }
        }
    }
}
