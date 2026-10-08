package com.hushos.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.LibraryAdd
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hushos.app.data.ContactPin
import com.hushos.app.data.Fingerprint
import com.hushos.app.data.LinkVault
import com.hushos.app.data.LinkView
import com.hushos.app.data.Lookup
import com.hushos.app.data.Opened
import com.hushos.app.data.OwnedShare
import com.hushos.app.data.Reports
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.Optional

private fun copyToClipboard(context: Context, label: String, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun firstName(name: String, email: String = "") = name.trim().split(Regex("\\s+")).firstOrNull { it.isNotEmpty() } ?: email.substringBefore('@')

/* "12 October": the day a link ends, as the web writes it. */
private fun longDate(iso: String): String? = runCatching {
    DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(Locale.UK, "dMMMM"), Locale.UK).format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
}.getOrNull()

/* "Opened 3 times · ends 12 October · password", or "Not opened yet", in the web's words. */
internal fun describeLink(link: LinkView): String = listOfNotNull(
    if (link.useCount == 0) "Not opened yet" else "Opened ${if (link.useCount == 1) "once" else "${link.useCount} times"}",
    link.expiresAt?.let { longDate(it) }?.let { "ends $it" },
    if (link.hasPassword) "password" else null,
).joinToString(" · ")

/* A person as initials on one of the four avatar tints, the same tint every time for the same account. */
@Composable
fun PersonAvatar(name: String, seed: String, size: Dp = 40.dp) {
    val alpine = Alpine.colors
    // The web's hash (31 * h + UTF-16 unit, 32-bit) and |h| mod n, so a person has one colour everywhere.
    val (background, ink) = alpine.avatars[Math.abs(seed.hashCode() % alpine.avatars.size)]
    val initials = name.trim().split(Regex("[\\s@.]+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1).uppercase() }.ifEmpty { "?" }
    Box(Modifier.size(size).background(background, CircleShape), contentAlignment = Alignment.Center) {
        Text(initials, color = ink, fontSize = (size.value * 0.38f).sp, fontWeight = FontWeight.SemiBold)
    }
}

/*
 * Who can open this?: the people an item is shared with, each with what they can
 * do, people who have it through a folder above, and its links. Sharing seals the
 * item's key to a contact's checked key, so only contacts can be chosen; someone
 * new is looked up by email and checked right here first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(model: DriveViewModel, state: DriveState, start: Opened, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // The sheet can move up to the folder someone has access through.
    var target by remember { mutableStateOf(start) }
    val item = model.item(target.id) ?: target
    var shares by remember(target.id) { mutableStateOf<List<OwnedShare>?>(null) }
    var pins by remember { mutableStateOf<List<ContactPin>>(emptyList()) }
    var links by remember(target.id) { mutableStateOf<List<Pair<LinkView, String?>>?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var chosen by remember { mutableStateOf<ContactPin?>(null) }
    var role by remember { mutableStateOf("viewer") }
    var pending by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var person by remember { mutableStateOf<OwnedShare?>(null) }
    var inherited by remember { mutableStateOf<Triple<String, String, Opened>?>(null) }
    var checking by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        val current = model.item(target.id) ?: target
        shares = model.shares(current) ?: emptyList()
        pins = model.contacts() ?: emptyList()
        links = model.links(current) ?: emptyList()
    }
    LaunchedEffect(target.id) { load() }
    if (checking != null) {
        CheckThemSheet(model, email = checking!!, pinned = null, dismiss = { checking = null }) { pin ->
            checking = null; query = ""; chosen = pin; scope.launch { pins = model.contacts() ?: pins }
            model.notify("${pin.name.ifEmpty { pin.email }} added to people you share with")
        }
        return
    }
    val me = state.user
    val already = shares.orEmpty().map { it.granteeId }.toSet()
    val typed = query.trim()
    val isEmail = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(typed)
    val matches = pins.filter { it.userId !in already && (typed.isEmpty() || "${it.name} ${it.email}".contains(typed, ignoreCase = true)) }
    val known = pins.any { it.email.equals(typed, ignoreCase = true) }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 560.dp).verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            ShareHeader(model, state, item)
            val picked = chosen
            if (picked == null) {
                OutlinedTextField(
                    value = query, onValueChange = { query = it; error = null }, singleLine = true,
                    label = { Text("Name or email") }, leadingIcon = { Icon(Icons.Outlined.PersonAdd, null) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6),
                )
                // Contacts as you type; someone new by their full email, checked before they are added.
                if (typed.isNotEmpty() || pins.isEmpty()) Column(Modifier.padding(top = AlpineSpace.S1)) {
                    for (pin in matches.take(5)) PersonRow(pin.name.ifEmpty { pin.email }, pin.email, pin.userId) { chosen = pin; query = "" }
                    if (isEmail && !known) SheetRow("Add “$typed”", Icons.Outlined.PersonAdd) { checking = typed }
                    if (matches.isEmpty() && !(isEmail && !known)) Text(
                        when {
                            pins.isEmpty() && typed.isEmpty() -> "Type their email to share with someone new."
                            known -> "They already have this."
                            else -> "No one by that name yet. Type their full email to add them."
                        },
                        style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2),
                    )
                }
            } else {
                Column(Modifier.padding(horizontal = AlpineSpace.S4).fillMaxWidth().border(1.dp, alpine.rule, RoundedCornerShape(AlpineRadius.Card)).padding(AlpineSpace.S3)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PersonAvatar(picked.name.ifEmpty { picked.email }, picked.userId)
                        Column(Modifier.weight(1f).padding(horizontal = AlpineSpace.S3)) {
                            Text(picked.name.ifEmpty { picked.email }, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(picked.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        IconButton(onClick = { chosen = null }) { Icon(Icons.Outlined.Close, "Choose someone else") }
                    }
                    Row(Modifier.padding(top = AlpineSpace.S2), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                        AlpineChip("Can view", selected = role == "viewer", onClick = { role = "viewer" })
                        AlpineChip("Can edit", selected = role == "editor", onClick = { role = "editor" })
                        Spacer(Modifier.weight(1f))
                        Button(enabled = pending == null, onClick = {
                            pending = "share"; error = null
                            scope.launch {
                                val current = model.item(target.id) ?: target
                                model.share(current, picked, role)
                                    .onSuccess {
                                        model.notify("“${current.name}” shared with ${picked.name.ifEmpty { picked.email }}")
                                        chosen = null; role = "viewer"; load(); model.refreshAccess()
                                    }
                                    .onFailure { error = it.message ?: "Couldn’t share. Check your connection and try again." }
                                pending = null
                            }
                        }) { Text(if (pending == "share") "Sharing…" else "Share") }
                    }
                }
            }
            error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2)) }

            Subheader("People")
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                PersonAvatar(me?.name?.ifEmpty { null } ?: me?.email ?: "You", me?.id ?: "you")
                Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                    Text(me?.name?.takeIf { it.isNotEmpty() }?.let { "$it (you)" } ?: "You", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    me?.email?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                Text("Owner", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(end = AlpineSpace.S2))
            }
            if (shares == null) Box(Modifier.fillMaxWidth().padding(AlpineSpace.S4), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
            for (share in shares.orEmpty()) {
                PersonRow(share.granteeName.ifEmpty { share.granteeEmail }, share.granteeEmail, share.granteeId, trailing = if (share.role == "editor") "Can edit" else "Can view") { person = share }
            }
            // People (and links) that have it through a folder above: said once, pointing to that folder.
            state.access?.let { access -> sharedAbove(model, access, item) }?.let { (folder, who) ->
                val folderName = if (folder.id == state.rootId) "Files" else folder.name
                for ((name, edit) in who.people) {
                    val seed = who.ids[name] ?: "${folder.id}:$name"
                    PersonRow(name, "From “$folderName”", seed, trailing = if (edit) "Can edit" else "Can view") { inherited = Triple(name, seed, folder) }
                }
                if (who.links > 0) Row(
                    Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable { target = folder }.padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(40.dp).background(alpine.tint, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Link, null, tint = alpine.primary) }
                    Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                        Text("Anyone with the link", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text("From “$folderName”: its link opens everything inside", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
                }
            }

            LinksSection(model, item, links, onChanged = { scope.launch { links = model.links(model.item(target.id) ?: target) ?: emptyList(); model.refreshAccess() } })
        }
    }
    person?.let { share ->
        PersonSheet(model, item, share, pins.firstOrNull { it.userId == share.granteeId }, dismiss = { person = null }) {
            person = null; scope.launch { load(); model.refreshAccess() }
        }
    }
    inherited?.let { (name, seed, folder) ->
        Sheet(onDismissRequest = { inherited = null }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PersonAvatar(name, seed, 48.dp)
                    Text(name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = AlpineSpace.S4))
                }
                Text("$name can open this through the folder “${folder.name}”. Change it there and it changes for everything inside.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                androidx.compose.material3.FilledTonalButton(onClick = { inherited = null; target = folder }, modifier = Modifier.fillMaxWidth()) { Text("Open “${folder.name}”") }
            }
        }
    }
}

/* The sheet's head: the item's mark, the question, and the item's name. */
@Composable
private fun ShareHeader(model: DriveViewModel, state: DriveState, item: Opened) {
    val alpine = Alpine.colors
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S6, end = AlpineSpace.S6, bottom = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Mark(item, bitmap, box = if (bitmap != null) 48.dp else 40.dp) }
        Column(Modifier.padding(start = AlpineSpace.S4)) {
            Text("Who can open this?", style = MaterialTheme.typography.titleLarge)
            Text(if (item.id == state.rootId) "Files" else item.name, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun PersonRow(name: String, detail: String, seed: String, trailing: String? = null, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        PersonAvatar(name, seed)
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
        }
    }
}

/*
 * Someone's access: what they can do as a choice, and Stop sharing as a labelled
 * red button that asks once. A new role is the same share sealed again with it.
 */
@Composable
private fun PersonSheet(model: DriveViewModel, item: Opened, share: OwnedShare, pin: ContactPin?, dismiss: () -> Unit, changed: () -> Unit) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    val name = share.granteeName.ifEmpty { share.granteeEmail }
    val first = firstName(share.granteeName, share.granteeEmail)
    var stopping by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                PersonAvatar(name, share.granteeId, 48.dp)
                Column(Modifier.padding(start = AlpineSpace.S4)) {
                    Text(name, style = MaterialTheme.typography.titleLarge)
                    Text(share.granteeEmail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
            }
            for ((role, label, detail) in listOf(Triple("viewer", "Can view", "Open and download"), Triple("editor", "Can edit", "Add, rename and delete inside"))) {
                // A new role needs their checked key; someone removed from your people keeps theirs until shared again.
                val enabled = !busy && (pin != null || role == share.role)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected = share.role == role, enabled = enabled, role = Role.RadioButton) {
                        if (role == share.role || pin == null) return@selectable
                        busy = true
                        scope.launch {
                            model.share(item, pin, role).onSuccess {
                                model.notify("$first ${if (role == "editor") "can edit" else "can view"} “${item.name}” now"); changed()
                            }.onFailure { model.notify("Couldn’t change what they can do. ${it.message ?: "Check your connection and try again."}") }
                            busy = false
                        }
                    }.padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = share.role == role, onClick = null, enabled = enabled)
                    Column(Modifier.padding(start = AlpineSpace.S4)) {
                        Text(label, style = MaterialTheme.typography.bodyLarge)
                        Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                }
            }
            if (pin == null) Text("$first isn’t in your people any more, so what they can do can’t change. Add them again to change it.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
            OutlinedButton(
                enabled = !busy, onClick = { stopping = true },
                border = androidx.compose.foundation.BorderStroke(1.dp, alpine.danger), colors = ButtonDefaults.outlinedButtonColors(contentColor = alpine.danger),
                modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S4).height(48.dp),
            ) { Text(if (busy) "Stopping…" else "Stop sharing with $first") }
        }
    }
    if (stopping) AlertDialog(
        onDismissRequest = { stopping = false },
        title = { Text("Stop sharing with $first?") },
        text = { Text("They can’t open “${item.name}” in HushOS any more. Copies they already downloaded stay with them. You can share it again later.") },
        confirmButton = { TextButton(onClick = {
            stopping = false; busy = true
            scope.launch {
                if (model.revokeShare(share, item)) model.notify("$name can’t open “${item.name}” any more")
                else model.notify("Couldn’t stop sharing. Check your connection and try again.")
                busy = false; changed()
            }
        }) { Text("Stop sharing", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { stopping = false }) { Text("Cancel") } },
    )
}

/*
 * Links anyone can open. An item can have several, each with its own password,
 * end date and count of opens, so one can be turned off without breaking the
 * others. Each is a card: Copy link, and the rest in its menu.
 */
@Composable
private fun LinksSection(model: DriveViewModel, item: Opened, links: List<Pair<LinkView, String?>>?, onChanged: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var making by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S4, end = AlpineSpace.S4, top = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        Text("Links", style = MaterialTheme.typography.titleSmall, color = alpine.primary, modifier = Modifier.weight(1f))
        OutlinedButton(enabled = !making && links != null, onClick = {
            making = true
            scope.launch {
                val current = model.item(item.id) ?: item
                val made = model.createLink(current, null, null)
                if (made != null) {
                    // A new link is copied at once, as before: it is what it was made for.
                    copyToClipboard(context, "HushOS link", made.second)
                    model.notify("Link copied. Anyone with it can view “${current.name}”.")
                    onChanged()
                } else model.notify("Couldn’t make a link. Check your connection and try again.")
                making = false
            }
        }) {
            Icon(Icons.Outlined.Link, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(AlpineSpace.S2)); Text(if (making) "Making…" else "New link")
        }
    }
    when {
        links == null -> Box(Modifier.fillMaxWidth().padding(AlpineSpace.S4), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
        links.isEmpty() -> Row(
            Modifier.padding(AlpineSpace.S4).fillMaxWidth().background(alpine.fill, RoundedCornerShape(AlpineRadius.Card)).padding(AlpineSpace.S4),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Link, null, tint = alpine.inkMuted)
            Text("No links. A link lets anyone who has it view “${item.name}”, with a password or an end date if you like.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(start = AlpineSpace.S3))
        }
        else -> Column(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
            for ((link, url) in links) LinkCard(model, item, link, url, several = links.size > 1, onChanged = onChanged)
        }
    }
}

@Composable
private fun LinkCard(model: DriveViewModel, item: Opened, link: LinkView, url: String?, several: Boolean, onChanged: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf(false) }
    var qr by remember { mutableStateOf(false) }
    var confirmOff by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(AlpineRadius.Card)
    Column(Modifier.fillMaxWidth().background(alpine.tint.copy(alpha = if (alpine.high) 1f else 0.4f).compositeOver(alpine.surface), shape).then(if (alpine.high) Modifier.border(1.dp, alpine.edge, shape) else Modifier).padding(AlpineSpace.S4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // The link, in Hush blue (links have no amber any more).
            Icon(Icons.Outlined.Link, null, tint = alpine.primary)
            Column(Modifier.weight(1f).padding(horizontal = AlpineSpace.S3)) {
                Text("Anyone with the link can view", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text((if (several) "Made ${runCatching { whenText(Instant.parse(link.createdAt).toEpochMilli()) }.getOrNull() ?: ""} · " else "") + describeLink(link),
                    style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            Box {
                IconButton(enabled = !busy, onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More for this link") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                    DropdownMenuItem(text = { Text("Password and end date") }, leadingIcon = { Icon(Icons.Outlined.Key, null) }, onClick = { menu = false; options = true })
                    DropdownMenuItem(text = { Text("Show as QR code") }, leadingIcon = { Icon(Icons.Outlined.QrCode2, null) }, enabled = url != null, onClick = { menu = false; qr = true })
                    DropdownMenuItem(text = { Text("Send link") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Send, null) }, enabled = url != null, onClick = {
                        menu = false
                        context.startActivity(shareChooser(context, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), item.name))
                    })
                    HorizontalDivider(color = alpine.divider)
                    DropdownMenuItem(text = { Text("Turn off link", color = alpine.danger) }, leadingIcon = { Icon(Icons.Outlined.LinkOff, null, tint = alpine.danger) }, onClick = { menu = false; confirmOff = true })
                }
            }
        }
        if (url == null) Text("This link was made before links could be shown again. Turn it off and make a new one.",
            style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(top = AlpineSpace.S2))
        Button(
            enabled = url != null && !busy,
            onClick = {
                copyToClipboard(context, "HushOS link", url!!); copied = true
                model.notify(link.expiresAt?.let { longDate(it) }?.let { "Link copied. Anyone with it can view “${item.name}” until $it." } ?: "Link copied. Anyone with it can view “${item.name}”.")
            },
            colors = ButtonDefaults.buttonColors(containerColor = alpine.ink, contentColor = alpine.surface),
            modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S3).height(48.dp),
        ) {
            Icon(if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(AlpineSpace.S2))
            Text(if (busy) "Turning off…" else if (copied) "Copied" else "Copy link")
        }
    }
    if (options) LinkOptionsSheet(model, item, link, dismiss = { options = false }, onTurnOff = { options = false; confirmOff = true }, onChanged = onChanged)
    if (qr && url != null) QrDialog(url, item.name, link.hasPassword) { qr = false }
    if (confirmOff) AlertDialog(
        onDismissRequest = { confirmOff = false },
        title = { Text("Turn off this link?") },
        text = { Text("Anyone who has it can’t open “${item.name}” any more. Other links keep working.") },
        confirmButton = { TextButton(onClick = {
            confirmOff = false; busy = true
            scope.launch {
                if (model.revokeLink(link, model.item(item.id) ?: item)) model.notify("Link turned off. Anyone who has it can’t open “${item.name}” any more.")
                else model.notify("Couldn’t turn the link off. Check your connection and try again.")
                busy = false; onChanged()
            }
        }) { Text("Turn off link", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { confirmOff = false }) { Text("Cancel") } },
    )
}

/* A link's password and end date. The password is typed into the link by whoever opens it; the address stays the same. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinkOptionsSheet(model: DriveViewModel, item: Opened, link: LinkView, dismiss: () -> Unit, onTurnOff: () -> Unit, onChanged: () -> Unit) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    var withPassword by remember { mutableStateOf(link.hasPassword) }
    var password by remember { mutableStateOf("") }
    // "keep" leaves the end date as it is; the rest set a new one from today.
    var ends by remember { mutableStateOf(if (link.expiresAt != null) "keep" else "never") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val choices = buildList {
        link.expiresAt?.let { longDate(it) }?.let { add("keep" to it) }
        add("never" to "Never"); add("7" to "7 days"); add("30" to "30 days"); add("365" to "A year")
    }
    val passwordReady = !withPassword || password.isNotEmpty() || link.hasPassword
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S6, end = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                Text("Password and end date", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(enabled = !saving && passwordReady, onClick = {
                    saving = true; error = null
                    scope.launch {
                        val newPassword = when {
                            !withPassword && link.hasPassword -> ""
                            withPassword && password.isNotEmpty() -> password
                            else -> null
                        }
                        val expiry: Optional<Instant>? = when (ends) {
                            "keep" -> null
                            "never" -> if (link.expiresAt == null) null else Optional.empty()
                            else -> Optional.of(Instant.now().plus(ends.toLong(), ChronoUnit.DAYS))
                        }
                        if (newPassword == null && expiry == null) { dismiss(); return@launch }
                        if (model.updateLink(link, model.item(item.id) ?: item, newPassword, expiry)) {
                            model.notify("Link updated. The link itself is the same."); onChanged(); dismiss()
                        } else error = "Couldn’t change the link. Check your connection and try again."
                        saving = false
                    }
                }) { Text(if (saving) "Saving…" else "Save") }
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = AlpineSpace.S6), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Password", style = MaterialTheme.typography.bodyLarge)
                    Text("They type it to open the link", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
                Switch(checked = withPassword, onCheckedChange = { withPassword = it })
            }
            if (withPassword) OutlinedTextField(
                value = password, onValueChange = { password = it }, singleLine = true, label = { Text("Link password") },
                placeholder = { if (link.hasPassword) Text("Keep the current password") },
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6),
            )
            Subheader("Ends")
            FlowRow(Modifier.padding(horizontal = AlpineSpace.S4), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                for ((value, label) in choices) AlpineChip(label, selected = ends == value, onClick = { ends = value })
            }
            error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(AlpineSpace.S6)) }
            HorizontalDivider(Modifier.padding(top = AlpineSpace.S4), color = alpine.divider)
            SheetRow("Turn off link", Icons.Outlined.LinkOff, danger = true, onClick = onTurnOff)
        }
    }
}

/* The link as a QR code, for a phone across the table. */
@Composable
private fun QrDialog(url: String, name: String, password: Boolean, dismiss: () -> Unit) {
    val bitmap = remember(url) { qrBitmap(url, 720) }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Link to $name", maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                // Dark on white in every theme: scanners expect it.
                Box(Modifier.background(Color.White, RoundedCornerShape(12.dp)).padding(12.dp)) {
                    Image(bitmap.asImageBitmap(), contentDescription = "QR code for the link to $name", modifier = Modifier.size(240.dp))
                }
                Text("Whoever scans it can open “$name”${if (password) " with the password" else ""}.", textAlign = TextAlign.Center, modifier = Modifier.padding(top = AlpineSpace.S3))
            }
        },
        confirmButton = { TextButton(onClick = dismiss) { Text("Done") } },
    )
}

private fun qrBitmap(text: String, size: Int): Bitmap {
    val matrix = com.google.zxing.qrcode.QRCodeWriter().encode(text, com.google.zxing.BarcodeFormat.QR_CODE, size, size,
        mapOf(com.google.zxing.EncodeHintType.MARGIN to 1, com.google.zxing.EncodeHintType.ERROR_CORRECTION to com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M))
    val pixels = IntArray(size * size) { i -> if (matrix.get(i % size, i / size)) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}

/*
 * Check it's them: the twelve words HushOS draws from their key, to compare with
 * what they read out from their own phone or browser. Nobody is added (or kept,
 * after their account changed) until "They match".
 */
@Composable
fun CheckThemSheet(model: DriveViewModel, email: String, pinned: ContactPin?, dismiss: () -> Unit, added: (ContactPin) -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<Lookup?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var mismatch by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    LaunchedEffect(email) { model.lookup(email).onSuccess { found = it }.onFailure { error = it.message ?: "Check the address and try again." } }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            val lookup = found
            if (lookup == null) {
                if (error == null) Box(Modifier.padding(AlpineSpace.S8)) { CircularProgressIndicator() }
                else {
                    Text("Couldn’t find $email", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                    Text(error!!, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center)
                    TextButton(onClick = dismiss) { Text("Back") }
                }
                return@Column
            }
            val contact = lookup.contact
            val first = firstName(contact.name, contact.email)
            val unsigned = contact.kemPublicKey != null && !contact.kemSigned
            PersonAvatar(contact.name.ifEmpty { contact.email }, contact.userId, 72.dp)
            Text("Check it’s $first", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            Text(contact.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            Text(
                if (lookup.changed) "$first’s account has changed since you added them on ${runCatching { whenText(Instant.parse(lookup.pinned!!.pinnedAt).toEpochMilli()) }.getOrNull() ?: "an earlier day"}. That can be a new phone or a reset, or someone pretending. Check it’s them before you accept."
                else "Ask $first to read you the twelve words HushOS shows for their account, on a call or in person. If they match these, it’s really them.",
                style = MaterialTheme.typography.bodyMedium, color = if (lookup.changed) alpine.danger else alpine.inkMuted, textAlign = TextAlign.Center,
            )
            WordGrid(Fingerprint.words(contact.fingerprint, Fingerprint.wordlist(context)))
            Text(
                when {
                    unsigned -> "$first’s newest key isn’t signed by their account. Don’t add them; ask them to sign in again first."
                    contact.kemPublicKey != null -> "Their newest key is signed by their account."
                    else -> "They get their newest key the next time they sign in."
                },
                style = MaterialTheme.typography.bodySmall, color = if (unsigned) alpine.danger else alpine.inkMuted, textAlign = TextAlign.Center,
            )
            if (mismatch) Text("Don’t share with this account. Check the email address with $first, then try again.", style = MaterialTheme.typography.bodyMedium, color = alpine.danger, textAlign = TextAlign.Center)
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.danger, textAlign = TextAlign.Center) }
            Button(
                enabled = !adding && !unsigned && !mismatch,
                onClick = {
                    adding = true; error = null
                    scope.launch {
                        if (model.pin(contact)) model.contacts()?.firstOrNull { it.userId == contact.userId }?.let(added) ?: run { error = "They weren’t saved. Try again." }
                        else error = "They weren’t saved. Try again."
                        adding = false
                    }
                },
                colors = if (lookup.changed) ButtonDefaults.buttonColors(containerColor = alpine.danger) else ButtonDefaults.buttonColors(),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Icon(Icons.Outlined.VerifiedUser, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(AlpineSpace.S2))
                Text(if (adding) "Adding…" else if (lookup.changed) "Accept change" else "They match")
            }
            OutlinedButton(enabled = !adding, onClick = { if (mismatch) dismiss() else mismatch = true }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Text(if (mismatch) "Back" else "They don’t match")
            }
        }
    }
}

/* Twelve words, numbered, in three columns. */
@Composable
fun WordGrid(words: List<String>) {
    val alpine = Alpine.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        words.chunked(3).forEachIndexed { row, three ->
            Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                three.forEachIndexed { column, word ->
                    Row(Modifier.weight(1f).background(alpine.fill, RoundedCornerShape(10.dp)).padding(horizontal = AlpineSpace.S2, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                        Text("${row * 3 + column + 1}", style = MaterialTheme.typography.labelSmall, color = alpine.inkMuted, modifier = Modifier.padding(end = AlpineSpace.S1))
                        Text(word, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1)
                    }
                }
            }
        }
    }
}

/*
 * People you share with: everyone this account added, a way to check each is
 * really them or remove them (asked first), someone new by email, and the twelve
 * words others read off this account.
 */
@Composable
fun PeopleSheet(model: DriveViewModel, state: DriveState, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var own by remember { mutableStateOf<String?>(null) }
    var pins by remember { mutableStateOf<List<ContactPin>?>(null) }
    var email by rememberSaveable { mutableStateOf("") }
    var checking by remember { mutableStateOf<Pair<String, ContactPin?>?>(null) }
    var open by remember { mutableStateOf<ContactPin?>(null) }
    var removing by remember { mutableStateOf<ContactPin?>(null) }
    suspend fun load() { own = model.ownFingerprint(); pins = model.contacts() ?: emptyList() }
    LaunchedEffect(Unit) { load() }
    checking?.let { (address, pinned) ->
        CheckThemSheet(model, address, pinned, dismiss = { checking = null }) { pin ->
            checking = null; email = ""; model.notify("${pin.name.ifEmpty { pin.email }} checked and added"); scope.launch { load() }
        }
        return
    }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 480.dp).verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S2, end = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, "Close") }
                Text("People you share with", style = MaterialTheme.typography.titleLarge)
            }
            Text("Everyone you’ve shared with or added. Check it’s them before you share anything sensitive.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
            Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = email, onValueChange = { email = it }, singleLine = true, label = { Text("Add someone by email") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.weight(1f))
                androidx.compose.material3.FilledTonalButton(enabled = email.contains("@"), onClick = { checking = email.trim() to null }, modifier = Modifier.padding(start = AlpineSpace.S2)) { Text("Add") }
            }
            val list = pins
            if (list == null) Box(Modifier.fillMaxWidth().padding(AlpineSpace.S6), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            // The web's and iOS's words for an empty list.
            else if (list.isEmpty()) Column(Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S4)) {
                Text("Nobody here yet", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text("Add someone by their email, or add them while you share.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            for (pin in list.orEmpty()) {
                val checked = runCatching { whenText(Instant.parse(pin.pinnedAt).toEpochMilli()) }.getOrNull()
                PersonRow(pin.name.ifEmpty { pin.email }, listOfNotNull(pin.email, checked?.let { "Checked $it" }).joinToString(" · "), pin.userId) { open = pin }
            }
            own?.let { fingerprint ->
                Subheader("Your twelve words")
                Text("Read these to someone checking it’s you.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4))
                Box(Modifier.padding(AlpineSpace.S4)) { WordGrid(Fingerprint.words(fingerprint, Fingerprint.wordlist(context))) }
            }
        }
    }
    open?.let { pin ->
        Sheet(onDismissRequest = { open = null }) {
            Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S6)) {
                Row(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S3), verticalAlignment = Alignment.CenterVertically) {
                    PersonAvatar(pin.name.ifEmpty { pin.email }, pin.userId, 48.dp)
                    Column(Modifier.padding(start = AlpineSpace.S4)) {
                        Text(pin.name.ifEmpty { pin.email }, style = MaterialTheme.typography.titleMedium)
                        Text(pin.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                }
                HorizontalDivider(color = alpine.divider)
                SheetRow("Check it’s them", Icons.Outlined.VerifiedUser) { open = null; checking = pin.email to pin }
                SheetRow("Remove", Icons.Outlined.PersonRemove, danger = true) { open = null; removing = pin }
            }
        }
    }
    removing?.let { pin ->
        val name = pin.name.ifEmpty { pin.email }
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove $name?") },
            text = { Text("$name keeps access to anything you’ve already shared. If you add them again, you’ll be asked to check it’s them.") },
            confirmButton = { TextButton(onClick = {
                removing = null
                scope.launch { if (model.unpin(pin)) { model.notify("$name removed"); load() } else model.notify("Couldn’t remove $name. Check your connection and try again.") }
            }) { Text("Remove", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

/* Report categories in the web's longer words, in its order. */
private val CATEGORY_LABELS = mapOf(
    "csam" to "Child sexual abuse material",
    "terrorism" to "Terrorist or violent extremist content",
    "ncii" to "Intimate images shared without consent",
    "malware" to "Malware or phishing",
    "copyright" to "Copyright infringement",
    "harassment" to "Harassment or threats",
    "other" to "Something else",
)

/*
 * Report: a full sheet. What it is (one list on every client), what is wrong, an
 * optional email; reporting lets the people who run the server open it so they
 * can look, and the sharer isn't told who reported it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportSheet(item: Opened, team: String, dismiss: () -> Unit, from: String? = null, submit: suspend (String, String, String?) -> Boolean?) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    var category by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<Boolean?>(null) }
    result?.let { already ->
        AlertDialog(
            onDismissRequest = dismiss,
            icon = { Icon(Icons.Outlined.CheckCircle, null, tint = alpine.primary) },
            title = { Text(if (already) "Already reported" else "Report sent") },
            text = { Text(if (already) "You’ve reported “${item.name}” before. ${team.replaceFirstChar { it.uppercase() }} has it; there’s nothing more to do."
                else "Thank you. ${team.replaceFirstChar { it.uppercase() }} can now open “${item.name}” and will look at it.") },
            confirmButton = { TextButton(onClick = dismiss) { Text("Done") } },
        )
        return
    }
    val categories = Reports.categories.map { (id, _) -> id to (CATEGORY_LABELS[id] ?: id) }
    Sheet(onDismissRequest = { if (!pending) dismiss() }, full = true) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
            Text("Report “${item.name}”", style = MaterialTheme.typography.titleLarge)
            Text("Reporting lets $team open ${if (item.isFolder) "this folder and everything inside it" else "this file"}, so they can look. ${from?.let { "$it isn’t told who reported it." } ?: "Whoever shared it isn’t told who reported it."}",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            // An exposed dropdown: the field shows the choice, the menu under it lists every category.
            Box {
                OutlinedTextField(
                    value = category?.let { CATEGORY_LABELS[it] } ?: "", onValueChange = {}, readOnly = true, singleLine = true,
                    label = { Text("What is it?") }, placeholder = { Text("Choose what it is") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = picking) },
                    modifier = Modifier.fillMaxWidth(),
                )
                // Over the field, so a tap anywhere on it opens the list (a read-only field takes no taps of its own).
                Box(Modifier.matchParentSize().clickable(role = Role.DropdownList, onClickLabel = "Choose what it is") { picking = true })
                DropdownMenu(expanded = picking, onDismissRequest = { picking = false }, containerColor = alpine.surface, modifier = Modifier.fillMaxWidth(0.86f)) {
                    for ((id, label) in categories) DropdownMenuItem(
                        text = { Text(label) },
                        trailingIcon = if (id == category) ({ Icon(Icons.Outlined.Check, null) }) else null,
                        onClick = { category = id; picking = false },
                        modifier = if (id == category) Modifier.background(alpine.tint) else Modifier,
                    )
                }
            }
            OutlinedTextField(value = reason, onValueChange = { reason = it }, label = { Text("What’s wrong with it?") }, supportingText = { Text("What you saw, and where inside it") },
                minLines = 3, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Your email (optional)") }, supportingText = { Text("Only if you want to hear back.") },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                TextButton(enabled = !pending, onClick = dismiss) { Text("Cancel") }
                Button(enabled = !pending && category != null && reason.isNotBlank(), onClick = {
                    pending = true; error = null
                    scope.launch {
                        runCatching { submit(category!!, reason.trim(), email.trim().ifEmpty { null }) }
                            .onSuccess { if (it == null) error = "Couldn’t send the report. Check your connection and try again." else result = it }
                            .onFailure { error = "Couldn’t send the report. Check your connection and try again." }
                        pending = false
                    }
                }) { Text(if (pending) "Sending…" else "Send report") }
            }
        }
    }
}

/* What a link that won't open says, in the same words as iOS and the web. */
internal enum class LinkTrouble(val title: String, val body: String) {
    GONE("This link no longer works", "Whoever shared it turned it off, or it reached its end date. Ask them for a new link."),
    INCOMPLETE("This link is incomplete", "The end of the link is missing, usually because it was cut off while copying. Paste the whole link."),
    FAILED("This link couldn’t be opened", "Check your connection and try again. If it keeps happening, ask for a new link."),
}

/*
 * An opened link, held by the view model so a rotation or a theme change doesn't lock
 * it again: its keys (in the vault), where you are in it, and the password you typed.
 * Only in memory: never in a saved-state bundle or on disk, and dropped when the link
 * closes or you sign out. Its loads run in the view model's scope, so they finish
 * across a rotation instead of starting over.
 */
internal class LinkSession(val url: String, private val origin: String, private val scope: CoroutineScope) {
    var vault: Result<LinkVault> by mutableStateOf(runCatching { LinkVault(origin, url) })
        private set
    val stack = mutableStateListOf<Opened>()
    var root by mutableStateOf<Opened?>(null)
        private set
    var children by mutableStateOf<Map<String, List<Opened>>>(emptyMap())
        private set
    var needsPassword by mutableStateOf(false)
        private set
    var password by mutableStateOf("")
    var wrong by mutableStateOf(false)
    var trouble by mutableStateOf(if (vault.isFailure) LinkTrouble.INCOMPLETE else null)
        private set
    private var looking = false
    private val listing = HashSet<String>()

    private fun troubleOf(error: Throwable) = when (error) {
        is com.hushos.app.data.Unreachable -> LinkTrouble.FAILED
        is com.hushos.app.data.NotFound -> LinkTrouble.GONE
        is com.hushos.app.data.ApiError -> if (error.status == 404 || error.status == 410) LinkTrouble.GONE else LinkTrouble.FAILED
        else -> LinkTrouble.FAILED
    }

    /* The first look: a password gate, or straight in. Once settled, a rotation doesn't look again. */
    fun start() {
        val v = vault.getOrNull() ?: return
        if (looking || root != null || needsPassword || trouble != null) return
        looking = true
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { v.needsPassword() } }
                .onSuccess { if (it) needsPassword = true else unlock() }.onFailure { trouble = troubleOf(it) }
            looking = false
        }
    }

    /* Opens the root, with the password when the link has one; a wrong one says so on the field. */
    fun unlock() {
        val v = vault.getOrNull() ?: return
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { v.open(if (needsPassword) password else null) } }
                .onSuccess { root = it; needsPassword = false; wrong = false; trouble = null; if (it.isFolder) list(it) }
                .onFailure { if (needsPassword && it !is com.hushos.app.data.Unreachable) wrong = true else trouble = troubleOf(it) }
        }
    }

    fun list(folder: Opened) {
        val v = vault.getOrNull() ?: return
        if (children.containsKey(folder.id) || !listing.add(folder.id)) return
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { v.children(folder.id) } }
                .onSuccess { children = children + (folder.id to it) }.onFailure { trouble = troubleOf(it) }
            listing.remove(folder.id)
        }
    }

    /* Try again after a failure: a fresh vault, from the top. */
    fun retry() {
        vault = runCatching { LinkVault(origin, url) }
        stack.clear(); root = null; children = emptyMap(); needsPassword = false; wrong = false
        trouble = if (vault.isFailure) LinkTrouble.INCOMPLETE else null
        start()
    }
}

/*
 * A link someone pasted or tapped: the password gate, then the folder or file
 * behind it, with Save a copy up front and Report in its ⋮ menu. Files still
 * open in another app. Its state is the view model's LinkSession.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LinkBrowser(model: DriveViewModel, state: DriveState, session: LinkSession, close: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val vault = session.vault
    val stack = session.stack
    val root = session.root
    val children = session.children
    var opening by remember { mutableStateOf<Pair<String, Float>?>(null) }
    var menu by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf(false) }
    var whole by remember { mutableStateOf("") }
    val current = stack.lastOrNull() ?: root
    LaunchedEffect(session) { session.start() }
    LaunchedEffect(current?.id) { current?.let { if (it.isFolder) session.list(it) } }
    BackHandler { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else close() }

    fun openFile(item: Opened) {
        val v = vault.getOrNull() ?: return
        scope.launch {
            // Per version: a replaced file is fetched anew, and a resumed partial never mixes two versions.
            val file = linkFile(context, item)
            if (!file.exists()) {
                opening = item.id to 0f
                val ok = runCatching { withContext(Dispatchers.IO) { v.download(item, file) { f -> opening = item.id to f } } }.isSuccess
                opening = null
                if (!ok) { model.notify("Couldn’t open “${item.name}”. Check your connection and try again."); return@launch }
            }
            openWith(context, androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file), mimeOf(item), model, item.name)
        }
    }
    val top = root
    Scaffold(contentWindowInsets = WindowInsets(0), containerColor = alpine.ground, topBar = {
        DestinationBar(current?.name ?: "Shared link", onBack = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else close() }) {
            if (top != null) Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                    DropdownMenuItem(text = { Text("Save a copy to my files") }, leadingIcon = { Icon(Icons.Outlined.LibraryAdd, null) }, onClick = { menu = false; vault.getOrNull()?.let { model.saveLinkCopy(it, top) } })
                    // A file opened from a link can go out through the system share sheet, as any file can.
                    val shown = current
                    if (shown != null && !shown.isFolder) DropdownMenuItem(text = { Text("Send a copy") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Send, null) }, onClick = {
                        menu = false
                        scope.launch {
                            val file = linkFile(context, shown)
                            val ok = file.exists() || runCatching { withContext(Dispatchers.IO) { vault.getOrThrow().download(shown, file) } }.isSuccess
                            if (!ok) { model.notify("Couldn’t prepare “${shown.name}”. Check your connection and try again."); return@launch }
                            val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file)
                            context.startActivity(shareChooser(context, Intent(Intent.ACTION_SEND).setType(mimeOf(shown) ?: "*/*").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), shown.name))
                        }
                    })
                    DropdownMenuItem(text = { Text("Report") }, leadingIcon = { Icon(Icons.Outlined.Flag, null) }, onClick = { menu = false; reporting = true })
                }
            }
        }
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            val problem = session.trouble
            when {
                problem != null -> Column(Modifier.fillMaxSize().padding(horizontal = 40.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    EmptyState(problem.title, problem.body, if (problem == LinkTrouble.GONE) Icons.Outlined.LinkOff else Icons.Outlined.ErrorOutline, danger = problem == LinkTrouble.FAILED) {
                        if (problem == LinkTrouble.FAILED) Button(onClick = { session.retry() }) { Text("Try again") }
                        if (problem == LinkTrouble.INCOMPLETE) {
                            OutlinedTextField(value = whole, onValueChange = { whole = it }, singleLine = true, label = { Text("Whole link") }, modifier = Modifier.fillMaxWidth())
                            Button(enabled = whole.contains("/s/"), onClick = { model.openLinkRequest(whole.trim()) }, modifier = Modifier.fillMaxWidth()) { Text("Open") }
                        }
                    }
                }
                session.needsPassword -> Column(Modifier.fillMaxWidth().padding(AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                    Box(Modifier.size(56.dp).background(alpine.tint, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Lock, null, tint = alpine.onTint) }
                    Text("This link has a password", style = MaterialTheme.typography.headlineSmall)
                    Text("Whoever shared it set one. Ask them if you don’t have it.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    PasswordField(session.password, { session.password = it; session.wrong = false }, "Password",
                        error = if (session.wrong) "That password didn’t work. Check it and try again." else null,
                        onGo = { if (session.password.isNotEmpty()) session.unlock() })
                    Button(enabled = session.password.isNotEmpty(), onClick = { session.unlock() }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Open") }
                }
                current == null -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Text("Opening the link", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = AlpineSpace.S4))
                    Text("This takes a moment on a slow connection.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    if (stack.isEmpty() && top != null) item(key = "head") {
                        Column(Modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S3), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                val count = children[top.id]?.size
                                AccessText(listOfNotNull("Opened from a link", count?.let { if (it == 1) "1 item" else "$it items" }, top.size?.let { formatBytes(it) }).joinToString(" · "), linked = true)
                            }
                            Button(onClick = { vault.getOrNull()?.let { model.saveLinkCopy(it, top) } }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                                Icon(Icons.Outlined.LibraryAdd, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(AlpineSpace.S2)); Text("Save a copy to my files")
                            }
                        }
                    }
                    val items = if (current.isFolder) children[current.id] else listOf(current)
                    if (items == null) item(key = "loading") { SkeletonRows(4) }
                    else if (items.isEmpty()) item(key = "empty") { EmptyState("Nothing in this folder.", modifier = Modifier.padding(top = 48.dp)) }
                    else items(items, key = { it.id }) { item -> LinkRow(item, opening?.takeIf { it.first == item.id }?.second) { if (item.isFolder) stack.add(item) else openFile(item) } }
                }
            }
        }
    }
    if (reporting) top?.let { item ->
        ReportSheet(item, model.reportsGoTo(state), dismiss = { reporting = false }) { category, reason, email ->
            withContext(Dispatchers.IO) { vault.getOrThrow().report(item, category, reason, email) }
        }
    }
}

/* Where a file opened from a link is kept: per version, so a replaced file is fetched anew. */
private fun linkFile(context: Context, item: Opened) = File(context.cacheDir, "links/${item.id}/${item.node.currentVersion?.id ?: "none"}/${item.name}")

/* A row inside a link: its mark, name, size and date, and the ring while it opens. */
@Composable
private fun LinkRow(item: Opened, opening: Float?, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Mark(item, null) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (opening != null) "Opening · ${(opening * 100).toInt()}%" else listOfNotNull(whenText(item.modifiedMillis), item.size?.let { formatBytes(it) }).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        if (opening != null) CircularProgressIndicator(progress = { opening }, modifier = Modifier.padding(horizontal = 13.dp).size(22.dp), strokeWidth = 2.5.dp)
    }
}

/* The 24 words, numbered, to be copied by hand. */
@Composable
fun PhraseGrid(phrase: String) {
    val words = phrase.split(" ")
    Column {
        words.chunked(2).forEachIndexed { row, pair ->
            Row(Modifier.fillMaxWidth()) {
                pair.forEachIndexed { column, word ->
                    Text("${row * 2 + column + 1}. $word", style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.weight(1f).padding(vertical = 2.dp))
                }
            }
        }
    }
}
