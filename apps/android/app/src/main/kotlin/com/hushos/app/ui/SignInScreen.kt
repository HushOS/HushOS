package com.hushos.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.ui.Alignment
import androidx.compose.material3.IconButton
import androidx.compose.material3.Icon
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/* The web's sign-in card in Material form: our words, the system's controls. */
@Composable
fun SignInScreen(model: DriveViewModel, state: DriveState) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var pending by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var editingOrigin by rememberSaveable { mutableStateOf(false) }
    var originDraft by rememberSaveable { mutableStateOf(state.origin) }
    val context = androidx.compose.ui.platform.LocalContext.current

    fun submit() {
        if (pending) return
        val address = email.trim()
        if (!address.contains("@")) { error = "Enter your email address."; return }
        if (password.isEmpty()) { error = "Enter your password."; return }
        error = ""
        pending = true
        model.signIn(address, password) { failure ->
            pending = false
            if (failure != null) error = failure else password = ""
        }
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(48.dp))
        Text("EXISTING ACCOUNT", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Welcome back", style = MaterialTheme.typography.displaySmall)
        Text("Sign in to unlock your account on this device.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text("Email") }, singleLine = true, enabled = !pending,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true, enabled = !pending,
            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { showPassword = !showPassword }) {
                    Icon(if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, contentDescription = if (showPassword) "Hide password" else "Show password")
                }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onGo = { submit() }),
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Password stays on this device. Your account key is unwrapped here and never sent.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = ::submit, enabled = !pending, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text(if (pending) "Unlocking…" else "Sign in")
        }
        TextButton(onClick = {
            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(state.origin + "/recover")))
        }) { Text("Forgot your password?") }
    }
    // Advanced: which HushOS this phone talks to, behind a gear so nobody else has to read an address.
    Box(Modifier.fillMaxSize().statusBarsPadding().padding(8.dp), contentAlignment = Alignment.TopEnd) {
        IconButton(onClick = { originDraft = state.origin; editingOrigin = true }) {
            Icon(Icons.Outlined.Settings, contentDescription = "Advanced", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (editingOrigin) {
        AlertDialog(
            onDismissRequest = { editingOrigin = false },
            title = { Text("HushOS address") },
            text = {
                Column {
                Text("Only for a self-hosted HushOS. Leave it alone otherwise.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                OutlinedTextField(value = originDraft, onValueChange = { originDraft = it }, singleLine = true, label = { Text("https://hush.example") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false))
                }
            },
            confirmButton = { TextButton(onClick = { model.setOrigin(originDraft); editingOrigin = false }) { Text("Done") } },
            dismissButton = { TextButton(onClick = { editingOrigin = false }) { Text("Cancel") } },
        )
    }
}
