package com.hushos.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Auth
import com.hushos.tokens.AlpineSpace

private fun hostOf(origin: String) = runCatching { java.net.URI(origin).host }.getOrNull() ?: origin.substringAfter("://")

/*
 * Sign in: a heading, two fields with an eye on the password, one button. No
 * claims about keys. Errors sit on the field they are about; a dropped connection
 * says so. The server's address is behind the gear, for self-hosted HushOS only,
 * and sign-in names the server once it isn't the usual one.
 */
@Composable
fun SignInScreen(model: DriveViewModel, state: DriveState) {
    val alpine = Alpine.colors
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var pending by rememberSaveable { mutableStateOf(false) }
    var emailError by rememberSaveable { mutableStateOf<String?>(null) }
    var passwordError by rememberSaveable { mutableStateOf<String?>(null) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var editingOrigin by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val custom = state.origin.trimEnd('/') != defaultOrigin().trimEnd('/')

    fun submit() {
        if (pending) return
        val address = email.trim()
        emailError = if (!address.contains("@")) "Enter your email address." else null
        passwordError = if (password.isEmpty()) "Enter your password." else null
        error = null
        if (emailError != null || passwordError != null) return
        pending = true
        model.signIn(address, password) { failure ->
            pending = false
            when (failure) {
                null -> password = ""
                Auth.MISMATCH -> passwordError = failure
                else -> error = failure
            }
        }
    }

    // Self-hosting › Server address, from the gear: a screen of its own, as on iOS.
    if (editingOrigin) { SelfHostingScreen(model, state, signedIn = false) { editingOrigin = false }; return }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(AlpineSpace.S6),
        verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
    ) {
        // The title at the top with the gear beside it (Self-hosting), so nobody else has to read an address.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Welcome back", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f))
            IconButton(onClick = { editingOrigin = true }, modifier = Modifier.offset(x = 12.dp)) {
                Icon(Icons.Outlined.Settings, contentDescription = "Self-hosting", tint = alpine.inkMuted)
            }
        }
        if (custom) Text("Signing in to ${hostOf(state.origin)}", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
        if (state.linkWaiting) Text("Sign in to open the link you followed.", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
        Spacer(Modifier.height(AlpineSpace.S2))
        error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
        OutlinedTextField(
            value = email, onValueChange = { email = it; emailError = null }, label = { Text("Email") }, placeholder = { Text("name@example.com") },
            singleLine = true, enabled = !pending, isError = emailError != null, supportingText = emailError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password, onValueChange = { password = it; passwordError = null }, label = { Text("Password") }, singleLine = true, enabled = !pending,
            isError = passwordError != null, supportingText = passwordError?.let { { Text(it) } },
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
        Button(onClick = ::submit, enabled = !pending, modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S2).height(48.dp)) {
            Text(if (pending) "Signing in…" else "Sign in")
        }
        // Recovery happens here in the app now, with the kit or the 24 words (RecoverScreen).
        TextButton(onClick = model::startRecovery) { Text("Forgot your password?") }
        // Accounts are made on the web; said as plain text, with no link to plans or pricing.
        Text("New to HushOS? Create an account at ${if (custom) hostOf(state.origin) else "hushos.com"}.", style = MaterialTheme.typography.bodyMedium,
            color = alpine.inkMuted, modifier = Modifier.padding(top = AlpineSpace.S4))
        // The server's privacy policy and terms, before anyone signs in.
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { openWebPage(context, privacyUrl(state.origin)) }) { Text("Privacy policy") }
            TextButton(onClick = { openWebPage(context, termsUrl(state.origin)) }) { Text("Terms") }
        }
    }
}
