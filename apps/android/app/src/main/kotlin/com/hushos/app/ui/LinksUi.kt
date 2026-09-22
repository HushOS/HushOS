package com.hushos.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Contact
import com.hushos.app.data.ContactPin
import com.hushos.app.data.LinkVault
import com.hushos.app.data.Lookup
import com.hushos.app.data.OwnedShare
import com.hushos.app.data.LinkView
import com.hushos.app.data.Opened
import com.hushos.app.data.Reports
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.DateFormat
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Date

private fun copyToClipboard(context: Context, label: String, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, text))
}

/* The links an owner made for one item, and a way to make another. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkSheet(model: DriveViewModel, item: Opened, dismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var links by remember { mutableStateOf<List<Pair<LinkView, String?>>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var withPassword by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var expiry by remember { mutableStateOf(0) }
    var pending by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf<String?>(null) }
    var shares by remember { mutableStateOf<List<OwnedShare>>(emptyList()) }
    var pins by remember { mutableStateOf<List<ContactPin>>(emptyList()) }
    var chosen by remember { mutableStateOf<ContactPin?>(null) }
    var role by remember { mutableStateOf("viewer") }
    var sharing by remember { mutableStateOf(false) }
    var showingContacts by remember { mutableStateOf(false) }
    val expiries = listOf("Never" to null, "7 days" to 7L, "30 days" to 30L)
    suspend fun load() {
        shares = model.shares(item) ?: emptyList()
        pins = model.contacts() ?: emptyList()
        links = model.links(item) ?: emptyList()
    }
    LaunchedEffect(item.id) { load() }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
            Text("Share “${item.name}”", style = MaterialTheme.typography.titleMedium)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Text("People", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
            shares.forEach { share ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(share.granteeName.ifEmpty { share.granteeEmail }, style = MaterialTheme.typography.bodyMedium)
                        Text(share.granteeEmail + " · " + (if (share.role == "editor") "Can edit" else "Can view") + (if (share.suite == 2) " · post-quantum" else ""),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { scope.launch { if (model.revokeShare(share, item)) load() } }) { Text("Revoke", color = MaterialTheme.colorScheme.error) }
                }
            }
            if (pins.isEmpty()) TextButton(onClick = { showingContacts = true }) { Text("Pin a contact to share with them…") }
            else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                    pins.forEach { pin -> FilterChip(selected = chosen?.userId == pin.userId, onClick = { chosen = if (chosen?.userId == pin.userId) null else pin }, label = { Text(pin.name.ifEmpty { pin.email }) }) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                    FilterChip(selected = role == "viewer", onClick = { role = "viewer" }, label = { Text("Can view") })
                    FilterChip(selected = role == "editor", onClick = { role = "editor" }, label = { Text("Can edit") })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Button(enabled = !sharing && chosen != null, onClick = {
                        sharing = true
                        scope.launch {
                            model.share(item, chosen!!, role).onSuccess { chosen = null; load() }.onFailure { error = it.message }
                            sharing = false
                        }
                    }, modifier = Modifier.padding(top = 8.dp)) { Text(if (sharing) "Sharing…" else "Share with this person") }
                    TextButton(onClick = { showingContacts = true }, modifier = Modifier.padding(start = 8.dp, top = 8.dp)) { Text("Contacts") }
                }
            }
            Text("Sharing seals this item's key to a contact you pinned. Revoking rotates the item's keys, so what they held opens nothing new.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("Links", style = MaterialTheme.typography.titleSmall)
            Text("Anyone with a link can open “${item.name}” until you revoke it. The key rides in the link itself; HushOS never sees it.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
            val current = links
            if (current == null) Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else if (current.isEmpty()) Text("No links yet.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
            current.orEmpty().forEach { (link, url) ->
                Column(Modifier.padding(vertical = 6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (link.hasPassword) Icons.Outlined.Lock else Icons.Outlined.Link, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(describeLink(link), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(enabled = url != null, onClick = { copyToClipboard(context, "HushOS link", url!!); copied = link.id }) { Text(if (copied == link.id) "Copied" else "Copy link") }
                        TextButton(enabled = url != null, onClick = {
                            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), item.name))
                        }) { Text("Share") }
                        TextButton(onClick = { scope.launch { if (model.revokeLink(link, item)) load() } }) { Text("Revoke", color = MaterialTheme.colorScheme.error) }
                    }
                    if (url == null) Text("Made before its secret was kept; revoke it and make a new one.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("New link", style = MaterialTheme.typography.titleSmall)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                Text("Password", modifier = Modifier.weight(1f))
                Switch(checked = withPassword, onCheckedChange = { withPassword = it })
            }
            if (withPassword) OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Link password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                expiries.forEachIndexed { index, (label, _) -> FilterChip(selected = expiry == index, onClick = { expiry = index }, label = { Text(label) }) }
            }
            Button(enabled = !pending && (!withPassword || password.isNotEmpty()), onClick = {
                pending = true
                scope.launch {
                    val expiresAt = expiries[expiry].second?.let { Instant.now().plus(it, ChronoUnit.DAYS) }
                    val made = model.createLink(item, if (withPassword) password else null, expiresAt)
                    if (made != null) { copyToClipboard(context, "HushOS link", made.second); copied = made.first.id; password = ""; withPassword = false; load() }
                    else error = "The link could not be made."
                    pending = false
                }
            }, modifier = Modifier.padding(top = 12.dp)) { Text(if (pending) "Creating…" else "Create link") }
        }
    }
    if (showingContacts) ContactsSheet(model) { showingContacts = false; scope.launch { pins = model.contacts() ?: emptyList() } }
}

/* Who this account trusts: pins made after comparing fingerprints, and a way to look someone up. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsSheet(model: DriveViewModel, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var own by remember { mutableStateOf<String?>(null) }
    var pins by remember { mutableStateOf<List<ContactPin>>(emptyList()) }
    var email by remember { mutableStateOf("") }
    var lookup by remember { mutableStateOf<Lookup?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() { own = model.ownFingerprint(); pins = model.contacts() ?: emptyList() }
    LaunchedEffect(Unit) { load() }
    fun pin(contact: Contact) {
        busy = true
        scope.launch {
            if (model.pin(contact)) { lookup = model.lookup(contact.email).getOrNull(); load() } else error = "The contact could not be pinned."
            busy = false
        }
    }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
            Text("Contacts", style = MaterialTheme.typography.titleMedium)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Text("Your fingerprint", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
            Text(own ?: "…", style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
            Text("Read it to the other person over a call or in person; they compare it with what HushOS shows them for you.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Look someone up", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = email, onValueChange = { email = it }, singleLine = true, label = { Text("Email") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.weight(1f))
                TextButton(enabled = !busy && email.contains("@"), onClick = {
                    busy = true
                    scope.launch { model.lookup(email.trim()).onSuccess { lookup = it; error = null }.onFailure { lookup = null; error = it.message }; busy = false }
                }, modifier = Modifier.padding(start = 8.dp)) { Text("Look up") }
            }
            lookup?.let { found ->
                Column(Modifier.padding(top = 8.dp)) {
                    Text(found.contact.name.ifEmpty { found.contact.email }, style = MaterialTheme.typography.titleSmall)
                    Text(found.contact.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(found.contact.fingerprint, style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                    val kemNote = when { found.contact.kemPublicKey == null -> "No post-quantum key yet"; found.contact.kemSigned -> "Post-quantum key signed by this identity"; else -> "Post-quantum key not signed: ignored" }
                    Text(kemNote, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (found.changed) Text("This key differs from the one you pinned. Check the fingerprint with them before pinning again.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    else if (found.pinned != null) Text("Pinned", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    Button(enabled = !busy, onClick = { pin(found.contact) }, modifier = Modifier.padding(top = 4.dp)) { Text(if (found.pinned == null) "Pin contact" else "Pin again") }
                }
            }
            Text("Pinned", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
            if (pins.isEmpty()) Text("Nobody yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            pins.forEach { pin ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(pin.name.ifEmpty { pin.email }, style = MaterialTheme.typography.bodyMedium)
                        Text(pin.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(pin.fingerprint, style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { scope.launch { if (model.unpin(pin)) load() } }) { Text("Unpin", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

private fun describeLink(link: LinkView): String {
    val parts = ArrayList<String>()
    runCatching { Instant.parse(link.createdAt).toEpochMilli() }.getOrNull()?.let { parts.add("Made " + DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it))) }
    parts.add(if (link.useCount == 1) "opened once" else "opened ${link.useCount} times")
    link.expiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }?.let { parts.add("expires " + DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it))) }
    return parts.joinToString(" · ")
}

/* A link someone pasted: the password gate, then the folder or file behind it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkBrowser(origin: String, url: String, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val vault = remember(url) { runCatching { LinkVault(origin, url) } }
    val stack = remember { mutableStateListOf<Opened>() }
    var root by remember { mutableStateOf<Opened?>(null) }
    var children by remember { mutableStateOf<Map<String, List<Opened>>>(emptyMap()) }
    var needsPassword by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var failure by remember { mutableStateOf(vault.exceptionOrNull()?.message) }
    var downloading by remember { mutableStateOf<String?>(null) }
    var reporting by remember { mutableStateOf(false) }
    val current = stack.lastOrNull() ?: root

    suspend fun list(folder: Opened) {
        val v = vault.getOrNull() ?: return
        runCatching { withContext(Dispatchers.IO) { v.children(folder.id) } }
            .onSuccess { children = children + (folder.id to it) }
            .onFailure { failure = it.message }
    }
    suspend fun open() {
        val v = vault.getOrNull() ?: return
        runCatching { withContext(Dispatchers.IO) { v.open(if (needsPassword) password else null) } }
            .onSuccess { root = it; needsPassword = false; failure = null; if (it.isFolder) list(it) }
            .onFailure { if (needsPassword) password = "" else failure = it.message }
    }
    LaunchedEffect(url) {
        val v = vault.getOrNull() ?: return@LaunchedEffect
        runCatching { withContext(Dispatchers.IO) { v.needsPassword() } }
            .onSuccess { if (it) needsPassword = true else open() }
            .onFailure { failure = it.message }
    }
    LaunchedEffect(current?.id) { current?.let { if (it.isFolder && !children.containsKey(it.id)) list(it) } }
    BackHandler { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else close() }

    fun openFile(item: Opened) {
        val v = vault.getOrNull() ?: return
        scope.launch {
            val file = File(context.cacheDir, "links/${item.id}/${item.name}")
            if (!file.exists()) {
                downloading = item.id
                val ok = runCatching { withContext(Dispatchers.IO) { v.download(item, file) } }.onFailure { failure = it.message }.isSuccess
                downloading = null
                if (!ok) return@launch
            }
            openWith(context, androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file), mimeOf(item))
        }
    }

    Scaffold(contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0), topBar = {
        TopAppBar(title = { Text(current?.name ?: "Shared link") },
            navigationIcon = { IconButton(onClick = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else close() }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            actions = { if (root != null) IconButton(onClick = { reporting = true }) { Icon(Icons.Outlined.Flag, "Report") } })
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            failure?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp)) }
            if (needsPassword) Column(Modifier.padding(24.dp)) {
                Text("Whoever shared this link set a password on it.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Link password") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Button(enabled = password.isNotEmpty(), onClick = { scope.launch { open() } }, modifier = Modifier.padding(top = 12.dp)) { Text("Open") }
            } else if (current != null && !current.isFolder) {
                ListItem(headlineContent = { Text(current.name) }, supportingContent = { Text(current.size?.let { formatBytes(it) } ?: "") },
                    trailingContent = { if (downloading == current.id) CircularProgressIndicator() },
                    modifier = Modifier.clickable { openFile(current) })
            } else if (current != null) {
                val items = children[current.id]
                if (items != null && items.isEmpty()) Text("This folder is empty.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
                LazyColumn(Modifier.fillMaxSize()) {
                    items(items.orEmpty(), key = { it.id }) { item ->
                        ListItem(headlineContent = { Text(item.name) },
                            supportingContent = { Text(if (item.isFolder) "Folder" else item.size?.let { formatBytes(it) } ?: "") },
                            trailingContent = { if (downloading == item.id) CircularProgressIndicator() },
                            modifier = Modifier.clickable { if (item.isFolder) stack.add(item) else openFile(item) })
                    }
                }
            }
        }
    }
    if (reporting) root?.let { item ->
        ReportDialog(item, dismiss = { reporting = false }) { category, reason, email ->
            withContext(Dispatchers.IO) { vault.getOrThrow().report(item, category, reason, email) }
        }
    }
}

/* Reporting something shared or linked: the category, the reason, and the key sealed to the operators. */
@Composable
fun ReportDialog(item: Opened, dismiss: () -> Unit, submit: suspend (String, String, String?) -> Boolean?) {
    val scope = rememberCoroutineScope()
    var category by remember { mutableStateOf("other") }
    var reason by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!pending) dismiss() },
        title = { Text("Report") },
        text = {
            if (done) Text("Thank you. The operators can now open “${item.name}” and act on it.")
            else Column {
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Reports.categories.forEach { (id, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { category = id }) {
                        androidx.compose.material3.RadioButton(selected = category == id, onClick = { category = id })
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(value = reason, onValueChange = { reason = it }, label = { Text("What is wrong with it?") }, minLines = 2, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email (optional)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Text("Reporting seals the key of “${item.name}” to the HushOS operators, and to nobody else, so they can look at it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            if (done) TextButton(onClick = dismiss) { Text("Done") }
            else TextButton(enabled = !pending && reason.isNotBlank(), onClick = {
                pending = true
                scope.launch {
                    runCatching { submit(category, reason.trim(), email.ifBlank { null }) }
                        .onSuccess { if (it == null) error = "The report could not be sent." else done = true }
                        .onFailure { error = it.message ?: "The report could not be sent." }
                    pending = false
                }
            }) { Text(if (pending) "Sending…" else "Send") }
        },
        dismissButton = { if (!done) TextButton(enabled = !pending, onClick = dismiss) { Text("Cancel") } },
    )
}

/* The 24 words, numbered, to be copied by hand. */
@Composable
fun PhraseGrid(phrase: String) {
    val words = phrase.split(" ")
    Column {
        words.chunked(2).forEachIndexed { row, pair ->
            Row(Modifier.fillMaxWidth()) {
                pair.forEachIndexed { column, word ->
                    Text("${row * 2 + column + 1}. $word", style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), modifier = Modifier.weight(1f).padding(vertical = 2.dp))
                }
            }
        }
    }
}
