package com.hushos.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.hushos.app.data.SignupRules
import com.hushos.tokens.AlpineSpace

/*
 * Create an account, in the app: the web's /register steps and words. The email and the terms,
 * "Check your inbox", the emailed link (which opens the app), then a name and a password. The
 * recovery kit comes next, signed in (PhraseScreen), and Drive opens once it is checked. No plans,
 * prices or codes anywhere here: those stay on the web.
 */
@Composable
fun SignupScreen(model: DriveViewModel, state: DriveState) {
    val flow = model.signup ?: return
    BackHandler(onBack = model::signupBack)
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
        DestinationBar("", onBack = if (flow.step == DriveViewModel.SignupStep.CHECKING) null else model::signupBack)
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S8),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4),
        ) {
            when (flow.step) {
                DriveViewModel.SignupStep.EMAIL -> SignupEmail(model, state, flow)
                DriveViewModel.SignupStep.SENT -> SignupSent(model, flow)
                DriveViewModel.SignupStep.CHECKING -> {
                    FlowHeading("Checking your link…", null)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("This only takes a moment.", Modifier.padding(start = AlpineSpace.S3), color = Alpine.colors.inkMuted)
                    }
                }
                DriveViewModel.SignupStep.LINK_FAILED -> SignupLinkFailed(model, flow)
                DriveViewModel.SignupStep.DETAILS -> SignupDetails(model, flow)
                DriveViewModel.SignupStep.CREATED -> {
                    FlowHeading("Your account is ready", "Sign in with your new password to carry on. You’ll save your recovery kit next.")
                    Button(onClick = model::leaveSignup, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Sign in") }
                }
                DriveViewModel.SignupStep.PHRASE -> {}
            }
        }
    }
}

private fun hostOf(origin: String) = runCatching { java.net.URI(origin).host }.getOrNull() ?: origin.substringAfter("://")

@Composable
private fun SignupEmail(model: DriveViewModel, state: DriveState, flow: DriveViewModel.SignupFlow) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var email by rememberSaveable { mutableStateOf(flow.email) }
    var agreed by rememberSaveable { mutableStateOf(false) }
    var tried by rememberSaveable { mutableStateOf(false) }
    val emailError = SignupRules.email(email)
    val agreeError = SignupRules.agreed(agreed)
    val custom = state.origin.trimEnd('/') != defaultOrigin().trimEnd('/')
    FlowHeading("Create your account", "We’ll email you a link to confirm it’s you.")
    if (custom) Text("On ${hostOf(state.origin)}", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
    flow.error?.let { FlowNote(it) }
    OutlinedTextField(
        email, { email = it }, label = { Text("Email") }, placeholder = { Text("name@example.com") }, singleLine = true, enabled = !flow.pending,
        isError = tried && emailError != null, supportingText = if (tried && emailError != null) ({ Text(emailError) }) else null,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    // The web's consent, with the server's own terms and privacy policy (the app=1 pages, which link to nothing that sells).
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = agreed, enabled = !flow.pending, role = Role.Checkbox) { agreed = it },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = agreed, onCheckedChange = null, enabled = !flow.pending)
            Text("I agree to the Terms of Service and Privacy Policy", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = AlpineSpace.S3))
        }
        if (tried && agreeError != null) Text(agreeError, style = MaterialTheme.typography.bodySmall, color = alpine.danger, modifier = Modifier.padding(start = 48.dp))
        Row {
            TextButton(onClick = { openWebPage(context, termsUrl(state.origin)) }) { Text("Terms of Service") }
            TextButton(onClick = { openWebPage(context, privacyUrl(state.origin)) }) { Text("Privacy Policy") }
        }
    }
    Button(
        onClick = { tried = true; if (emailError == null && agreeError == null) model.sendSignupEmail(email) },
        enabled = !flow.pending, modifier = Modifier.fillMaxWidth().height(48.dp),
    ) { Text(if (flow.pending) "Sending…" else "Send link") }
    TextButton(onClick = model::leaveSignup, enabled = !flow.pending) { Text("Already have an account? Sign in") }
}

@Composable
private fun SignupSent(model: DriveViewModel, flow: DriveViewModel.SignupFlow) {
    Icon(Icons.Outlined.Mail, null, tint = Alpine.colors.primary, modifier = Modifier.padding(top = AlpineSpace.S4).size(32.dp))
    FlowHeading("Check your inbox", "We sent a link to ${flow.email}. Open it to carry on. It works once, for 30 minutes.")
    if (flow.resent) FlowNote("New link sent to ${flow.email}.", danger = false)
    flow.error?.let { FlowNote(it) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = model::signupEmailAgain) { Text("Use another email") }
        TextButton(enabled = !flow.pending, onClick = { model.sendSignupEmail(flow.email, again = true) }) { Text(if (flow.pending) "Sending…" else "Send a new link") }
    }
    Text("Not there? Check your spam folder. The link opens HushOS on this phone, or the web anywhere else.", style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted)
}

/* The web's words for a link that can't be used: another flow's, expired or used, or something else. */
@Composable
private fun SignupLinkFailed(model: DriveViewModel, flow: DriveViewModel.SignupFlow) {
    val error = flow.error.orEmpty()
    val otherFlow = error.contains("different account flow")
    val expired = Regex("expired|invalid|used|not valid|no longer", RegexOption.IGNORE_CASE).containsMatchIn(error)
    FlowHeading(
        when { otherFlow -> "This link is for something else"; expired -> "This link has expired"; else -> "This link didn’t work" },
        when {
            otherFlow -> "It resets a password rather than creating an account. Open the newest email, or ask for a new link here."
            expired -> "Links work once, for 30 minutes. Send yourself a new one and open the newest email."
            else -> error
        },
    )
    Button(onClick = model::signupEmailAgain, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Send a new link") }
}

/* Name and password, as the web's "Set up your account". The password stays in memory, never in saved state. */
@Composable
private fun SignupDetails(model: DriveViewModel, flow: DriveViewModel.SignupFlow) {
    var name by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    val nameError = SignupRules.name(name)
    val passwordError = SignupRules.password(password)
    val confirmError = SignupRules.confirm(password, confirm)
    SecureWindow()
    FlowHeading("Set up your account", "Your email is confirmed: ${flow.email}")
    flow.error?.let { FlowNote(it) }
    OutlinedTextField(
        name, { name = it }, label = { Text("Name") }, singleLine = true, enabled = !flow.pending,
        isError = tried && nameError != null, supportingText = { Text(if (tried && nameError != null) nameError else "Shown to people you share with.") },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth(),
    )
    PasswordField(password, { password = it }, "Password", enabled = !flow.pending,
        error = if (tried) passwordError else null, hint = if (!tried || passwordError == null) "At least 12 characters. A few unrelated words work well." else null)
    PasswordField(confirm, { confirm = it }, "Confirm password", enabled = !flow.pending,
        error = if (tried || (confirm.isNotEmpty() && confirm.length >= password.length)) confirmError else null)
    Button(enabled = !flow.pending, modifier = Modifier.fillMaxWidth().height(48.dp), onClick = {
        tried = true
        if (nameError == null && passwordError == null && confirmError == null) model.createAccount(name.trim(), password)
    }) { Text(if (flow.pending) "Creating your account…" else "Create account") }
}
