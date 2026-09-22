package com.hushos.app.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.Password
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.WorkspacePremium
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

private enum class AccountDialog { NONE, NAME, PASSWORD, PHRASE, ROTATE, DELETE, SIGN_OUT }

/* Account: who is signed in, the plan and its storage, security, the trash, the Files app, and the way out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(model: DriveViewModel, state: DriveState) {
    var dialog by rememberSaveable { mutableStateOf(AccountDialog.NONE) }
    var showingTrash by rememberSaveable { mutableStateOf(false) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    LaunchedEffect(Unit) { model.refreshStorage(); model.refreshAccount() }
    if (showingTrash) {
        BackHandler { showingTrash = false }
        TrashScreen(model, state) { showingTrash = false }
        return
    }
    Scaffold(contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0), topBar = { TopAppBar(title = { Text("Account") }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            state.user?.let { user ->
                ListItem(
                    headlineContent = { Text(user.name.ifEmpty { "Signed in" }, style = MaterialTheme.typography.titleMedium) },
                    supportingContent = { Text(user.email.ifEmpty { state.origin }) },
                    leadingContent = { Icon(Icons.Outlined.AccountCircle, null, tint = MaterialTheme.colorScheme.primary) },
                    trailingContent = { TextButton(onClick = { dialog = AccountDialog.NAME }) { Text("Edit") } },
                )
            }
            HorizontalDivider()
            ListItem(
                overlineContent = { Text("Plan and storage") },
                headlineContent = { Text(state.billing?.planName ?: "Free") },
                supportingContent = {
                    Column {
                        state.allowance?.let {
                            Text("${formatBytes(it.usedBytes)} of ${formatBytes(it.quotaBytes)}")
                            LinearProgressIndicator(progress = { (it.usedBytes.toFloat() / maxOf(it.quotaBytes, 1L)).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                        }
                        Text(state.billing?.periodEnd?.let { end -> (if (state.billing.cancelAtPeriodEnd) "Ends " else "Renews ") + end.take(10) } ?: "Plans are chosen and paid for on the web.",
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
                    }
                },
                leadingContent = { Icon(Icons.Outlined.WorkspacePremium, null) },
                trailingContent = { TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(state.origin + "/app/billing"))) }) { Text("Manage") } },
            )
            HorizontalDivider()
            ListItem(headlineContent = { Text("Change password") }, supportingContent = { Text("The password you sign in with.") },
                leadingContent = { Icon(Icons.Outlined.Password, null) }, modifier = Modifier.clickable { dialog = AccountDialog.PASSWORD })
            ListItem(headlineContent = { Text("Recovery phrase") }, supportingContent = { Text("24 words that get you back in if you forget your password.") },
                leadingContent = { Icon(Icons.Outlined.Key, null) }, modifier = Modifier.clickable { dialog = AccountDialog.PHRASE })
            ListItem(headlineContent = { Text("Rotate keys") }, supportingContent = { Text("New keys and a new recovery phrase, if you think either was exposed.") },
                leadingContent = { Icon(Icons.Outlined.Autorenew, null) }, modifier = Modifier.clickable { dialog = AccountDialog.ROTATE })
            HorizontalDivider()
            ListItem(
                headlineContent = { Text("Trash") },
                supportingContent = { state.storage?.let { Text("${formatBytes(it.trashBytes)} in the trash · ${formatBytes(it.supersededBytes)} in earlier versions") } },
                leadingContent = { Icon(Icons.Outlined.Delete, null) },
                modifier = Modifier.clickable { showingTrash = true },
            )
            ListItem(
                headlineContent = { Text("HushOS in Files") },
                // The address only matters to someone on their own server; everyone else never needs to read it.
                supportingContent = { Text("Browse, open and save files from the Files app and any app's file picker." + if (state.origin != defaultOrigin()) "\nServer: ${state.origin.removePrefix("https://")}" else "") },
                leadingContent = { Icon(Icons.Outlined.FolderOpen, null) },
            )
            HorizontalDivider()
            ListItem(
                headlineContent = { Text("Sign out") },
                leadingContent = { Icon(Icons.Outlined.Logout, null) },
                modifier = Modifier.clickable { dialog = AccountDialog.SIGN_OUT },
            )
            ListItem(headlineContent = { Text("Delete account", color = MaterialTheme.colorScheme.error) }, supportingContent = { Text("Deletes every file and the account. This cannot be undone.") },
                leadingContent = { Icon(Icons.Outlined.DeleteForever, null, tint = MaterialTheme.colorScheme.error) }, modifier = Modifier.clickable { dialog = AccountDialog.DELETE })
            Text("HushOS ${com.hushos.app.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
    when (dialog) {
        AccountDialog.NONE -> {}
        AccountDialog.NAME -> {
            var name by rememberSaveable { mutableStateOf(state.user?.name ?: "") }
            AlertDialog(
                onDismissRequest = { dialog = AccountDialog.NONE },
                title = { Text("Your name") },
                text = { OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true) },
                confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { model.updateName(name.trim()) { notice = it }; dialog = AccountDialog.NONE }) { Text("Save") } },
                dismissButton = { TextButton(onClick = { dialog = AccountDialog.NONE }) { Text("Cancel") } },
            )
        }
        AccountDialog.PASSWORD -> {
            var current by rememberSaveable { mutableStateOf("") }
            var new by rememberSaveable { mutableStateOf("") }
            var confirm by rememberSaveable { mutableStateOf("") }
            var pending by rememberSaveable { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = { if (!pending) dialog = AccountDialog.NONE },
                title = { Text("Change password") },
                text = {
                    Column {
                        OutlinedTextField(value = current, onValueChange = { current = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                        OutlinedTextField(value = new, onValueChange = { new = it }, label = { Text("New password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.padding(top = 8.dp))
                        OutlinedTextField(value = confirm, onValueChange = { confirm = it }, label = { Text("Repeat new password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.padding(top = 8.dp))
                        Text("Your account key is opened with the current password and sealed again under the new one.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
                    }
                },
                confirmButton = {
                    TextButton(enabled = !pending && current.isNotEmpty() && new.length >= 12 && new == confirm, onClick = {
                        pending = true
                        model.changePassword(current, new) { pending = false; notice = it; if (it == "Your password was changed.") dialog = AccountDialog.NONE }
                    }) { Text(if (pending) "Changing…" else "Change") }
                },
                dismissButton = { TextButton(enabled = !pending, onClick = { dialog = AccountDialog.NONE }) { Text("Cancel") } },
            )
        }
        AccountDialog.PHRASE -> {
            var phrase by remember { mutableStateOf<String?>(null) }
            var error by remember { mutableStateOf<String?>(null) }
            LaunchedEffect(Unit) { phrase = model.recoveryPhrase() ?: run { error = "The recovery phrase could not be opened."; null } }
            AlertDialog(
                onDismissRequest = { dialog = AccountDialog.NONE },
                title = { Text("Recovery phrase") },
                text = {
                    Column {
                        phrase?.let { PhraseGrid(it) } ?: error?.let { Text(it, color = MaterialTheme.colorScheme.error) } ?: Text("Opening…")
                        Text("These 24 words open your account if you forget your password. Keep them somewhere safe and offline; anyone who has them has your files.",
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
                    }
                },
                confirmButton = { TextButton(onClick = { dialog = AccountDialog.NONE }) { Text("Done") } },
                dismissButton = { phrase?.let { p -> TextButton(onClick = { (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Recovery phrase", p)) }) { Text("Copy") } } },
            )
        }
        AccountDialog.ROTATE -> {
            var password by rememberSaveable { mutableStateOf("") }
            var pending by rememberSaveable { mutableStateOf(false) }
            var phrase by rememberSaveable { mutableStateOf<String?>(null) }
            var error by remember { mutableStateOf<String?>(null) }
            AlertDialog(
                onDismissRequest = { if (!pending && phrase == null) dialog = AccountDialog.NONE },
                title = { Text(if (phrase == null) "Rotate keys" else "Your new recovery phrase") },
                text = {
                    Column {
                        phrase?.let {
                            PhraseGrid(it)
                            Text("Your keys were rotated. The old recovery phrase no longer works; write these 24 words down before you leave.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
                        } ?: run {
                            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                            OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                            Text("A fresh account key replaces the current one. Your identity and workspace keys are sealed again under it, a new recovery phrase is made, and every other session is signed out. Files, shares and links do not change.",
                                style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                },
                confirmButton = {
                    if (phrase != null) TextButton(onClick = { dialog = AccountDialog.NONE }) { Text("I wrote it down") }
                    else TextButton(enabled = !pending && password.isNotEmpty(), onClick = {
                        pending = true
                        model.rotateKeys(password) { made, failure -> pending = false; phrase = made; error = failure }
                    }) { Text(if (pending) "Rotating…" else "Rotate") }
                },
                dismissButton = { if (phrase == null) TextButton(enabled = !pending, onClick = { dialog = AccountDialog.NONE }) { Text("Cancel") } },
            )
        }
        AccountDialog.DELETE -> {
            var password by rememberSaveable { mutableStateOf("") }
            var phrase by rememberSaveable { mutableStateOf("") }
            var pending by rememberSaveable { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = { if (!pending) dialog = AccountDialog.NONE },
                title = { Text("Delete account") },
                text = {
                    Column {
                        Text("Deleting removes every file, every version and the account itself. Nothing can be recovered afterwards.")
                        OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.padding(top = 12.dp))
                        OutlinedTextField(value = phrase, onValueChange = { phrase = it }, label = { Text("Type DELETE to confirm") }, singleLine = true, modifier = Modifier.padding(top = 8.dp))
                    }
                },
                confirmButton = {
                    TextButton(enabled = !pending && password.isNotEmpty() && phrase == "DELETE", onClick = {
                        pending = true
                        model.deleteAccount(password) { pending = false; notice = it }
                    }) { Text(if (pending) "Deleting…" else "Delete", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(enabled = !pending, onClick = { dialog = AccountDialog.NONE }) { Text("Cancel") } },
            )
        }
        AccountDialog.SIGN_OUT -> AlertDialog(
            onDismissRequest = { dialog = AccountDialog.NONE },
            title = { Text("Sign out of HushOS?") },
            confirmButton = { TextButton(onClick = { dialog = AccountDialog.NONE; model.signOut() }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { dialog = AccountDialog.NONE }) { Text("Cancel") } },
        )
    }
    notice?.let { message ->
        AlertDialog(onDismissRequest = { notice = null }, title = { Text("Account") }, text = { Text(message) },
            confirmButton = { TextButton(onClick = { notice = null }) { Text("OK") } })
    }
}
