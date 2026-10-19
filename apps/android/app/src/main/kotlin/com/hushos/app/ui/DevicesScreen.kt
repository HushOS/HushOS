package com.hushos.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.hushos.app.data.AccountDevice
import com.hushos.app.data.Auth
import com.hushos.tokens.AlpineSpace

/*
 * Devices (docs/devices-design.md, step 1): this phone, then every other device
 * signed in to the account, how each got in and when it was last seen. Rename
 * any of them; remove any but this one (signing out is how this one leaves).
 * Removing signs a device out at once; what it already holds may stay on it,
 * and the words say so.
 */
@Composable
fun DevicesScreen(model: DriveViewModel, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var devices by remember { mutableStateOf<List<AccountDevice>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<AccountDevice?>(null) }
    var removing by remember { mutableStateOf<AccountDevice?>(null) }
    var removingOthers by remember { mutableStateOf(false) }
    var loads by remember { mutableIntStateOf(0) }
    LaunchedEffect(loads) { model.loadDevices { list, failure -> devices = list ?: devices; problem = failure } }
    val reload: () -> Unit = { loads++ }
    val current = devices?.firstOrNull { it.current }
    val others = devices?.filterNot { it.current }.orEmpty()

    Scaffold(contentWindowInsets = WindowInsets(0), containerColor = alpine.ground, topBar = { DestinationBar("Devices", onBack = onBack) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S8)) {
            when {
                problem != null && devices == null -> Column(Modifier.padding(AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    Text(problem!!, color = alpine.danger)
                    TextButton(onClick = reload) { Text("Try again") }
                }
                devices == null -> CircularProgressIndicator(Modifier.padding(AlpineSpace.S6).align(Alignment.CenterHorizontally))
                else -> {
                    current?.let {
                        Subheader(if (Auth.isTablet(androidx.compose.ui.platform.LocalContext.current)) "This tablet" else "This phone")
                        DeviceRow(it, onRename = { renaming = it }, onRemove = null)
                    }
                    Subheader("Other devices")
                    if (others.isEmpty()) Text("No other devices are signed in.", color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
                    others.forEach { device -> DeviceRow(device, onRename = { renaming = device }, onRemove = { removing = device }) }
                    if (others.isNotEmpty()) {
                        TextButton(onClick = { removingOthers = true }, modifier = Modifier.padding(horizontal = AlpineSpace.S2)) {
                            Text("Remove all other devices", color = alpine.danger)
                        }
                        Text("They’re signed out at once and need your password to sign in again.", style = MaterialTheme.typography.bodySmall,
                            color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4))
                    }
                }
            }
        }
    }

    renaming?.let { device ->
        var name by remember(device.id) { mutableStateOf(device.name.orEmpty()) }
        var error by remember(device.id) { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename device") },
            text = {
                Column {
                    Text("Shown in your list of devices. Device names aren’t encrypted.", modifier = Modifier.padding(bottom = AlpineSpace.S3))
                    OutlinedTextField(value = name, onValueChange = { name = it.take(40); error = null }, singleLine = true, label = { Text("Name") },
                        isError = error != null, supportingText = error?.let { { Text(it) } })
                }
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    model.changeDevices({ context -> Auth.renameDevice(context, device.id, name.trim()) }) { failure ->
                        if (failure == null) { renaming = null; reload() } else error = failure
                    }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }

    removing?.let { device ->
        RemoveDialog(
            title = "Remove ${device.label}?",
            text = "It’s signed out at once and needs your password to sign in again. Anything already on it, such as files kept there, may stay there. If it was lost or stolen, change your password too.",
            verb = "Remove",
            onDismiss = { removing = null },
        ) { password, failed ->
            model.changeDevices({ context -> Auth.removeDevice(context, device.id, password) }) { failure ->
                if (failure == null) { removing = null; model.notify("Device removed"); reload() } else failed(failure)
            }
        }
    }

    if (removingOthers) RemoveDialog(
        title = "Remove all other devices?",
        text = "They’re signed out at once and need your password to sign in again. Anything already on them, such as files kept there, may stay there. If one was lost or stolen, change your password too.",
        verb = "Remove all other devices",
        onDismiss = { removingOthers = false },
    ) { password, failed ->
        model.changeDevices({ context -> Auth.removeOtherDevices(context, password) }) { failure ->
            if (failure == null) { removingOthers = false; model.notify("Other devices removed"); reload() } else failed(failure)
        }
    }
}

/* A removal asks for the password; a wrong one is said in the dialog, which stays open. */
@Composable
private fun RemoveDialog(title: String, text: String, verb: String, onDismiss: () -> Unit, onRemove: (String, (String) -> Unit) -> Unit) {
    val alpine = Alpine.colors
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!pending) onDismiss() },
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                Text(text)
                PasswordField(password, { password = it; error = null }, "Your password", error = error, enabled = !pending)
            }
        },
        confirmButton = {
            TextButton(enabled = !pending && password.isNotEmpty(), onClick = {
                pending = true
                onRemove(password) { failure -> pending = false; error = failure }
            }) { Text(if (pending) "Removing…" else verb, color = alpine.danger) }
        },
        dismissButton = { TextButton(enabled = !pending, onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeviceRow(device: AccountDevice, onRename: () -> Unit, onRemove: (() -> Unit)?) {
    val alpine = Alpine.colors
    // The day only: the server rounds last-seen to the hour, and a time of day would say when the owner is up.
    val seen = whenText(runCatching { java.time.Instant.parse(device.lastSeenAt).toEpochMilli() }.getOrNull())
        ?.let { if (it.startsWith("Today")) "today" else if (it == "Yesterday") "yesterday" else it } ?: ""
    val activity = if (device.signedIn) "Active $seen" else "Signed out · Last active $seen"
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(device.label, style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            Text(listOfNotNull(device.approval, activity).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        TextButton(onClick = onRename) { Text("Rename") }
        onRemove?.let { TextButton(onClick = it) { Text("Remove", color = alpine.danger) } }
    }
}
