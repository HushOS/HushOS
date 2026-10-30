package com.hushos.app.ui

import androidx.compose.runtime.retain.retain
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
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Badge
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
import androidx.compose.material.icons.outlined.Search
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
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.withStyle
import com.hushos.app.data.AccountChange
import com.hushos.app.data.AccountChanged
import com.hushos.app.data.Added
import com.hushos.app.data.ContactStanding
import com.hushos.app.data.GuardWords
import com.hushos.app.data.Problems
import com.hushos.app.data.ContactPin
import com.hushos.app.data.Fingerprint
import com.hushos.app.data.LinkKdf
import com.hushos.app.data.LinkVault
import com.hushos.app.data.LinkView
import com.hushos.app.data.Lookup
import com.hushos.app.data.OldLink
import com.hushos.app.data.Opened
import com.hushos.app.data.OwnedShare
import com.hushos.app.data.PeopleFilter
import com.hushos.app.data.Reports
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.Optional

/* A link carries its key: copied as sensitive, and gone from the clipboard after two minutes (SensitiveClipboard). */
private fun copyToClipboard(context: Context, label: String, text: String) = SensitiveClipboard.copy(context, label, text)

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
 * Who can open this?: the people an item is shared with, each with what they can do, people who have it through a
 * folder above, and its links. Someone new is added by their email and shared with in one step, with the role chosen
 * on its own line under the field (docs/optional-verification.md 6.3); an account that changed waits for Review, which
 * takes the sheet's place, and what it stopped runs again once Review settled it. Stopping a share never waits on Review.
 */
private sealed interface Interrupted {
    data class Share(val pin: ContactPin, val role: String) : Interrupted
    data class New(val email: String, val role: String) : Interrupted
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(model: DriveViewModel, state: DriveState, start: Opened, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    // The sheet can move up to the folder someone has access through.
    var target by retain { mutableStateOf(start) }
    val item = model.item(target.id) ?: target
    var shares by remember(target.id) { mutableStateOf<List<OwnedShare>?>(null) }
    var pins by remember { mutableStateOf<List<ContactPin>>(emptyList()) }
    var links by remember(target.id) { mutableStateOf<List<Pair<LinkView, String?>>?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var chosen by retain { mutableStateOf<ContactPin?>(null) }
    var role by retain { mutableStateOf("viewer") }
    var pending by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var person by retain { mutableStateOf<OwnedShare?>(null) }
    var inherited by retain { mutableStateOf<Triple<String, String, Opened>?>(null) }
    // Review or Check it's Maya, in the sheet's place; the act a changed account stopped, and whether Review settled it.
    var step by retain { mutableStateOf<ContactStep?>(null) }
    var interrupted by retain { mutableStateOf<Interrupted?>(null) }
    var settled by retain { mutableStateOf(false) }
    // People on this item whose account changed (2.4): their row says so, and their role waits.
    var changed by retain { mutableStateOf<Set<String>>(emptySet()) }
    /* `people`: look the people on it up again (opening, Review); a reload after this sheet's own share or role change doesn't. */
    suspend fun load(people: Boolean = true) {
        val current = model.item(target.id) ?: target
        shares = model.shares(current) ?: emptyList()
        pins = model.contacts() ?: emptyList()
        if (people) {
            // Met here too (2.4): who on this item has an account that changed, from the keys served now (kept a minute
            // by the vault, three at a time). A lookup that fails is said, never read as "nothing changed".
            val onIt = shares.orEmpty().mapNotNull { share -> pins.firstOrNull { it.userId.equals(share.granteeId, ignoreCase = true) } }
            val (moved, failure) = model.shareeChanges(onIt)
            changed = moved
            failure?.let { error = Problems.say(it, GuardWords.UNREADABLE) }
        }
        links = model.links(current) ?: emptyList()
    }
    LaunchedEffect(target.id) { load() }
    fun share(pin: ContactPin, asRole: String) {
        pending = "share"; error = null
        scope.launch {
            val current = model.item(target.id) ?: target
            model.share(current, pin, asRole)
                .onSuccess {
                    model.notify("“${current.name}” shared with ${pin.displayName}")
                    chosen = null; role = "viewer"
                    // This sheet's own share: the person was just checked by it, so nobody is looked up again.
                    load(people = false); model.refreshAccess()
                }
                .onFailure { failure ->
                    if (failure is AccountChanged) { interrupted = Interrupted.Share(pin, asRole); step = ContactStep.Changed(failure.change) }
                    else error = Problems.say(failure, "Couldn’t share. Check your connection and try again.")
                }
            pending = null
        }
    }
    /* Someone new by their email (6.3): added as Add someone adds them, and shared with, in one step. */
    fun shareWithNew(email: String, asRole: String) {
        pending = "share"; error = null
        scope.launch {
            val current = model.item(target.id) ?: target
            val added = model.addContact(email).getOrElse { failure ->
                error = Problems.say(failure, "Check the address and try again."); pending = null; return@launch
            }
            val pin = when (added) {
                is Added.New -> added.pin
                is Added.Already -> added.pin
                is Added.Changed -> { interrupted = Interrupted.New(email, asRole); step = ContactStep.Changed(added.change); pending = null; return@launch }
            }
            model.share(current, pin, asRole)
                .onSuccess {
                    model.notify("Shared with ${pin.firstName}")
                    query = ""; role = "viewer"
                    load(people = false); model.refreshAccess()
                }
                .onFailure { failure ->
                    if (failure is AccountChanged) { interrupted = Interrupted.New(email, asRole); step = ContactStep.Changed(failure.change) }
                    else error = Problems.say(failure, "Couldn’t share. Check your connection and try again.")
                }
            pending = null
        }
    }
    step?.let { shown ->
        ContactStepSheet(model, shown, resolved = { settled = true }) {
            // Review settled the change: what it stopped runs again, with the keys looked up afresh.
            val act = if (settled) interrupted else null
            step = null; settled = false; interrupted = null
            scope.launch { load() }
            when (act) {
                is Interrupted.Share -> share(act.pin, act.role)
                is Interrupted.New -> shareWithNew(act.email, act.role)
                null -> Unit
            }
        }
        return
    }
    val me = state.user
    val already = shares.orEmpty().map { it.granteeId.lowercase() }.toSet()
    val typed = query.trim()
    val isEmail = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(typed)
    val matches = pins.filter { it.userId.lowercase() !in already && (typed.isEmpty() || "${it.name} ${it.email}".contains(typed, ignoreCase = true)) }
    val known = pins.any { it.email.equals(typed, ignoreCase = true) }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 560.dp).verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            ShareHeader(model, state, item)
            val picked = chosen
            if (picked == null) {
                OutlinedTextField(
                    value = query, onValueChange = { query = it; error = null }, singleLine = true,
                    label = { Text("Add a name or email") }, leadingIcon = { Icon(Icons.Outlined.PersonAdd, null) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6),
                )
                RoleLine(role) { role = it }
                // Contacts as you type; someone new by their full email, added and shared with in one step: the list's first row.
                if (typed.isNotEmpty() || pins.isEmpty()) Column(Modifier.padding(top = AlpineSpace.S1)) {
                    if (isEmail && !known) Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(enabled = pending == null) { shareWithNew(typed, role) }.padding(horizontal = AlpineSpace.S4),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(40.dp).background(alpine.tint, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.PersonAdd, null, tint = alpine.primary, modifier = Modifier.size(20.dp)) }
                        Text(if (pending == "share") "Sharing…" else "Share with $typed", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).padding(start = AlpineSpace.S4))
                    }
                    for (pin in matches.take(5)) PersonRow(pin.displayName, pin.email, pin.userId) { chosen = pin; query = "" }
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
                        PersonAvatar(picked.displayName, picked.userId)
                        Column(Modifier.weight(1f).padding(horizontal = AlpineSpace.S3)) {
                            Text(picked.displayName, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(picked.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        IconButton(onClick = { chosen = null }) { Icon(Icons.Outlined.Close, "Choose someone else") }
                    }
                    Row(Modifier.fillMaxWidth().padding(top = AlpineSpace.S2), horizontalArrangement = Arrangement.End) {
                        Button(enabled = pending == null, onClick = { share(picked, role) }) { Text(if (pending == "share") "Sharing…" else "Share") }
                    }
                }
                RoleLine(role) { role = it }
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
                // Always their sheet: Stop sharing never waits on Review (only a new role does), as on the web.
                PersonRow(share.granteeName.ifEmpty { share.granteeEmail }, share.granteeEmail, share.granteeId, trailing = if (share.role == "editor") "Can edit" else "Can view",
                    changed = share.granteeId.lowercase() in changed) { person = share }
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
        val id = share.granteeId.lowercase()
        PersonSheet(model, item, share, pins.firstOrNull { it.userId.equals(share.granteeId, ignoreCase = true) }, changed = id in changed,
            settledChange = { changed = changed - id }, dismiss = { person = null }) {
            person = null; scope.launch { load(people = false); model.refreshAccess() }
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

/*
 * What they can do, chosen before anything is shared (6.3): on a phone a line of its own under the field, so "Add a
 * name or email" is never cut off.
 */
@Composable
private fun RoleLine(role: String, choose: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        Text("What they can do", style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted, modifier = Modifier.weight(1f))
        AlpineChip("Can view", selected = role == "viewer", onClick = { choose("viewer") })
        AlpineChip("Can edit", selected = role == "editor", onClick = { choose("editor") })
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
private fun PersonRow(name: String, detail: String, seed: String, trailing: String? = null, changed: Boolean = false, end: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        PersonAvatar(name, seed)
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (changed) AccountChangedLine() else Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        end?.invoke()
        trailing?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
        }
    }
}

/*
 * A row whose account changed (6.3, 6.5): "Account changed · Review" in Contacts' words (the name is the row's title),
 * never cut short: it wraps rather than truncates, and "· Review" never starts a line of its own.
 */
@Composable
private fun AccountChangedLine() {
    val alpine = Alpine.colors
    Text(
        androidx.compose.ui.text.buildAnnotatedString {
            append("Account changed\u00A0·\u00A0")
            withStyle(androidx.compose.ui.text.SpanStyle(color = alpine.primary, fontWeight = FontWeight.SemiBold)) { append("Review") }
        },
        style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
    )
}

/*
 * Someone's access: what they can do as a choice, Check it's Maya, and Stop sharing as a labelled red button that asks
 * once, last (6.3). A new role is the same share sealed again with it; while their account changed it waits for Review,
 * which takes this sheet's place. Stopping never waits.
 */
@Composable
private fun PersonSheet(model: DriveViewModel, item: Opened, share: OwnedShare, pin: ContactPin?, changed: Boolean, settledChange: () -> Unit, dismiss: () -> Unit, reload: () -> Unit) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    val name = share.granteeName.ifEmpty { share.granteeEmail }
    val first = firstName(share.granteeName, share.granteeEmail)
    var stopping by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var waitingChange by remember { mutableStateOf(changed) }
    var step by retain { mutableStateOf<ContactStep?>(null) }
    var waiting by retain { mutableStateOf<String?>(null) }
    var settled by retain { mutableStateOf(false) }
    fun changeRole(role: String) {
        val current = pin ?: return
        busy = true
        scope.launch {
            model.share(item, current, role).onSuccess {
                model.notify("$first ${if (role == "editor") "can edit" else "can view"} “${item.name}” now"); reload()
            }.onFailure { failure ->
                if (failure is AccountChanged) { waiting = role; step = ContactStep.Changed(failure.change) }
                else model.notify("Couldn’t change what they can do. ${Problems.say(failure, "Check your connection and try again.")}")
            }
            busy = false
        }
    }
    step?.let { shown ->
        ContactStepSheet(model, shown, resolved = { settled = true }) {
            // The role a changed account stopped belongs to this Review only: dismissed unsettled, it is dropped, so a
            // later, separate Check it's Maya never grants it.
            val role = if (settled) waiting else null
            val wasSettled = settled
            step = null; settled = false; waiting = null
            // Review settled the change: the role may change again, and one it stopped runs again.
            if (wasSettled) {
                waitingChange = false; settledChange()
                role?.let { changeRole(it) }
            }
        }
        return
    }
    // Opened whole, never half way: with an account changed (Review, Check it's Maya) Stop sharing, which never waits on
    // Review, would otherwise start below the fold.
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                PersonAvatar(name, share.granteeId, 48.dp)
                Column(Modifier.padding(start = AlpineSpace.S4)) {
                    Text(name, style = MaterialTheme.typography.titleLarge)
                    Text(share.granteeEmail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
            }
            for ((role, label, detail) in listOf(Triple("viewer", "Can view", "Open and download"), Triple("editor", "Can edit", "Add, rename and delete inside"))) {
                // A new role needs their key as this phone holds it: someone removed keeps theirs, someone changed waits for Review.
                val enabled = !busy && ((pin != null && !waitingChange) || role == share.role)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected = share.role == role, enabled = enabled, role = Role.RadioButton) {
                        if (role != share.role) changeRole(role)
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
            if (waitingChange) Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { step = ContactStep.Changed(AccountChange(share.granteeId, share.granteeName, share.granteeEmail)) }
                    .padding(horizontal = AlpineSpace.S6),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("$first’s account changed", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Text("Review", style = MaterialTheme.typography.bodyLarge, color = alpine.primary, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = AlpineSpace.S2))
            }
            if (pin != null) SheetRow("Check it’s $first", Icons.Outlined.VerifiedUser, action = true) { step = ContactStep.Check(share.granteeEmail, share.granteeName) }
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
                busy = false; reload()
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
                        // Best effort: the clip marks the link sensitive for a share sheet that copies it, and a copy of it
                        // left on the clipboard is cleared like our own. What the receiving app does with it is its own.
                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url).apply { clipData = sensitiveClip("HushOS link", url!!) }
                        SensitiveClipboard.watch(context, url!!)
                        context.startActivity(shareChooser(context, send, item.name))
                    })
                    HorizontalDivider(color = alpine.divider)
                    DropdownMenuItem(text = { Text("Turn off link", color = alpine.danger) }, leadingIcon = { Icon(Icons.Outlined.LinkOff, null, tint = alpine.danger) }, onClick = { menu = false; confirmOff = true })
                }
            }
        }
        if (url == null) Text(if (!link.current) OldLink().message!! else "This link was made before links could be shown again. Turn it off and make a new one.",
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
    var withPassword by retain { mutableStateOf(link.hasPassword) }
    var password by retain { mutableStateOf("") }
    // "keep" leaves the end date as it is; the rest set a new one from today.
    var ends by retain { mutableStateOf(if (link.expiresAt != null) "keep" else "never") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val choices = buildList {
        link.expiresAt?.let { longDate(it) }?.let { add("keep" to it) }
        add("never" to "Never"); add("7" to "7 days"); add("30" to "30 days"); add("365" to "A year")
    }
    // A new password needs eight characters (the core refuses fewer); empty keeps the current one.
    val tooShort = withPassword && password.isNotEmpty() && password.length < LinkKdf.MIN_PASSWORD
    val passwordReady = !withPassword || (password.isNotEmpty() && !tooShort) || (password.isEmpty() && link.hasPassword)
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
            // The eye, as on sign-in: a link password is typed once and never shown again, so seeing it matters.
            if (withPassword) PasswordField(
                password, { password = it }, "Link password",
                hint = "At least 8 characters",
                placeholder = if (link.hasPassword) "Keep the current password" else null,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6),
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

/*
 * The link as a QR code, for a phone across the table. The code is the whole link, secret included: its window
 * (a dialog has its own) is kept out of screenshots, recordings and the recents preview.
 */
@Composable
private fun QrDialog(url: String, name: String, password: Boolean, dismiss: () -> Unit) {
    val bitmap = remember(url) { qrBitmap(url, 720) }
    AlertDialog(
        onDismissRequest = dismiss,
        properties = androidx.compose.ui.window.DialogProperties(securePolicy = androidx.compose.ui.window.SecureFlagPolicy.SecureOn),
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
 * Twelve words, numbered, in two columns, one at the largest font sizes: an eight-letter word never shares a third of
 * the width with two others, and a word is never cut short (no line limit; a word wider than its cell wraps).
 */
@Composable
fun WordGrid(words: List<String>) {
    val alpine = Alpine.colors
    val columns = if (LocalDensity.current.fontScale >= 1.8f) 1 else 2
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        words.chunked(columns).forEachIndexed { row, cells ->
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                cells.forEachIndexed { column, word ->
                    Row(Modifier.weight(1f).fillMaxHeight().background(alpine.fill, RoundedCornerShape(10.dp)).padding(horizontal = AlpineSpace.S2, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                        Text("${row * columns + column + 1}", style = MaterialTheme.typography.labelSmall, color = alpine.inkMuted, modifier = Modifier.padding(end = AlpineSpace.S1))
                        Text(word, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

/*
 * A fingerprint as twelve words, or Show as code: the same fingerprint as hex, as the
 * web offers, for checking against an app that still shows it that way; the words are
 * drawn from that code, so either matching means the same.
 */
@Composable
fun FingerprintWords(fingerprint: String) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var code by rememberSaveable { mutableStateOf(false) }
    val words = remember(fingerprint) { Fingerprint.words(fingerprint, Fingerprint.wordlist(context)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S1)) {
        if (code) Text(fingerprint, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth().background(alpine.fill, RoundedCornerShape(10.dp)).padding(horizontal = AlpineSpace.S3, vertical = AlpineSpace.S3))
        else WordGrid(words)
        TextButton(onClick = { code = !code }) { Text(if (code) "Show as words" else "Show as code") }
    }
}

/*
 * Your twelve words: what others check when they add this person, read aloud from here. One sheet for the app (Main
 * draws it while `DriveViewModel.showingOwnWords`), from a row at the top of People and from Account, so it is a tap
 * away while someone waits on a call.
 *
 * What is guaranteed: each opening (and each re-creation, after a rotation) asks the server which identity it serves
 * and, if that is not the one this process opened (keys replaced on another device), opens the served one first
 * (`Vault.currentOwnFingerprint`). The words are always computed from the public keys the core re-derived from the
 * private halves, never from served keys. Without the server it says why rather than show words it can't confirm. The
 * sheet closes when the session ends (a 401 anywhere signs out) or another account signs in, and sign-in, sign-out and
 * a lost session clear the flag, so nothing reopens it.
 */
@Composable
fun OwnWordsSheet(model: DriveViewModel, state: DriveState, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val signedIn = if (state.gate == Gate.SIGNED_IN) state.user?.id else null
    val account = remember { signedIn }
    LaunchedEffect(signedIn) { if (signedIn == null || signedIn != account) dismiss() }
    var words by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { words = model.ownFingerprint { error = it } ?: run { if (error == null) error = "Couldn’t open them. Try again."; null } }
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            Text("Your twelve words", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text("When someone checks it’s you, read these to them. They’re the same on all your devices.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            val shown = words
            when {
                shown != null -> FingerprintWords(shown)
                error != null -> Text(error!!, style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
                else -> Box(Modifier.fillMaxWidth().heightIn(min = 144.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.semantics { contentDescription = "Opening your words" })
                }
            }
        }
    }
}

/*
 * Contacts (docs/optional-verification.md 6.5): Add someone and Your twelve words first, so neither is buried under a
 * long list, then everyone added, by name (Find someone from eight of them), each with Verified or Not verified, an
 * account that changed with Review, and Check it's Maya (Check again once verified) and Remove in its menu.
 */
@Composable
fun PeopleSheet(model: DriveViewModel, state: DriveState, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    var pins by remember { mutableStateOf<List<ContactPin>?>(null) }
    // Where each stands on this phone, by lowercased id; null until read, and when the guard couldn't be.
    var standings by remember { mutableStateOf<Map<String, ContactStanding>?>(null) }
    var standingsError by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var step by retain { mutableStateOf<ContactStep?>(null) }
    var open by retain { mutableStateOf<ContactPin?>(null) }
    var removing by retain { mutableStateOf<ContactPin?>(null) }
    // By name, as iOS and the web list them (accents count, case doesn't), not newest first.
    val byName = remember { java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY } }
    suspend fun load() {
        pins = (model.contacts() ?: emptyList()).sortedWith(compareBy(byName) { it.name })
        model.contactStandings().onSuccess { standings = it; standingsError = null }
            .onFailure { standings = null; standingsError = Problems.say(it, GuardWords.UNREADABLE) }
    }
    LaunchedEffect(Unit) { load() }
    step?.let { shown ->
        ContactStepSheet(model, shown) { step = null; scope.launch { load() } }
        return
    }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 480.dp).verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S2, end = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, "Close") }
                Text("Contacts", style = MaterialTheme.typography.titleLarge)
            }
            Text("People you share with. Add someone by the email they use for HushOS.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
            SheetRow("Add someone", Icons.Outlined.PersonAdd, action = true) { step = ContactStep.Add() }
            // Right under adding someone, above the list, so it is never buried however many people there are.
            SheetRow("Your twelve words", Icons.Outlined.Badge, action = true) { model.openOwnWords() }
            val list = pins
            // What this phone remembers couldn't be read: nobody is shown as verified, and acts wait.
            standingsError?.let { words ->
                Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2)) {
                    Text(words, style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { scope.launch { load() } }) { Text("Try again") }
                }
            }
            val shown = list?.let { PeopleFilter.shown(it, query) }
            if (list != null && PeopleFilter.offered(list.size, query)) {
                TextField(
                    value = query, onValueChange = { query = it }, singleLine = true,
                    placeholder = { Text("Find someone") },
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    leadingIcon = { Icon(Icons.Outlined.Search, null, tint = alpine.ink) },
                    trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear search") } },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    shape = CircleShape,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = alpine.fill, unfocusedContainerColor = alpine.fill,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                        unfocusedPlaceholderColor = alpine.inkMuted, focusedPlaceholderColor = alpine.inkMuted,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)
                        .then(if (alpine.high) Modifier.border(1.dp, alpine.field, CircleShape) else Modifier)
                        // Its name for TalkBack, which the placeholder isn't once something is typed.
                        .semantics { contentDescription = "Find someone by name or email" },
                )
            }
            val result = if (list == null || shown == null) null else PeopleFilter.result(shown.size, list.size, query)
            // What typing found ("2 of 8 shown", "Nobody here matches “…”."), on screen and said by TalkBack as a live
            // region: settled once typing pauses, so it isn't read out at every letter TalkBack already echoes.
            var said by remember { mutableStateOf<String?>(null) }
            LaunchedEffect(result) { if (result == null) said = null else { delay(400); said = result } }
            said?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
                    modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2).semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (list == null) Box(Modifier.fillMaxWidth().padding(AlpineSpace.S6), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            // The web's and iOS's words for an empty list.
            else if (list.isEmpty()) Column(Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S4)) {
                Text("Nobody here yet", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text("Add someone by their email, or add them while you share.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            for (pin in shown.orEmpty()) {
                val standing = standings?.get(pin.userId.lowercase())
                PersonRow(pin.displayName, pin.email, pin.userId, changed = standing?.changed == true,
                    end = { if (standing != null && !standing.changed) VerifiedLabel(standing.verified, Modifier.padding(start = AlpineSpace.S2)) }) { open = pin }
            }
        }
    }
    open?.let { pin ->
        val standing = standings?.get(pin.userId.lowercase())
        Sheet(onDismissRequest = { open = null }) {
            Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S6)) {
                Row(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S3), verticalAlignment = Alignment.CenterVertically) {
                    PersonAvatar(pin.displayName, pin.userId, 48.dp)
                    Column(Modifier.padding(start = AlpineSpace.S4)) {
                        Text(pin.displayName, style = MaterialTheme.typography.titleMedium)
                        Text(pin.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                }
                HorizontalDivider(color = alpine.divider)
                if (standing?.changed == true) SheetRow("Review", Icons.Outlined.ErrorOutline) {
                    open = null; step = ContactStep.Changed(AccountChange(pin.userId, pin.name, pin.email))
                }
                SheetRow(if (standing?.verified == true) "Check again" else "Check it’s ${pin.firstName}", Icons.Outlined.VerifiedUser) {
                    open = null; step = ContactStep.Check(pin.email, pin.name)
                }
                SheetRow("Remove", Icons.Outlined.PersonRemove, danger = true) { open = null; removing = pin }
            }
        }
    }
    removing?.let { pin ->
        val first = pin.firstName
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove $first?") },
            text = { Text("$first keeps access to anything you’ve already shared.") },
            confirmButton = { TextButton(onClick = {
                removing = null
                scope.launch {
                    model.removeContact(pin.userId).onSuccess { model.notify("$first removed"); load() }
                        .onFailure { model.notify("Couldn’t remove them. ${Problems.say(it, "Try again.")}") }
                }
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
    var category by retain { mutableStateOf<String?>(null) }
    var picking by retain { mutableStateOf(false) }
    var reason by retain { mutableStateOf("") }
    var email by retain { mutableStateOf("") }
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
                        com.hushos.app.data.attempt { submit(category!!, reason.trim(), email.trim().ifEmpty { null }) }
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
    OLD("This link can’t be opened", "This link was made by an older version of HushOS. Ask for a new link."),
    NEWER("Update HushOS", "This item was made by a newer version of HushOS. Update the app to open it."),
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
        is com.hushos.app.data.OldLink -> LinkTrouble.OLD
        is com.hushos.app.data.NewerFormat -> LinkTrouble.NEWER
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
            com.hushos.app.data.attempt { withContext(Dispatchers.IO) { v.needsPassword() } }
                .onSuccess { if (it) needsPassword = true else unlock() }.onFailure { trouble = troubleOf(it) }
            looking = false
        }
    }

    /* Opens the root, with the password when the link has one; a wrong one says so on the field. */
    fun unlock() {
        val v = vault.getOrNull() ?: return
        scope.launch {
            com.hushos.app.data.attempt { withContext(Dispatchers.IO) { v.open(if (needsPassword) password else null) } }
                .onSuccess { root = it; needsPassword = false; wrong = false; trouble = null; if (it.isFolder) list(it) }
                .onFailure { if (needsPassword && it !is com.hushos.app.data.Unreachable && it !is com.hushos.app.data.Refused) wrong = true else trouble = troubleOf(it) }
        }
    }

    fun list(folder: Opened) {
        val v = vault.getOrNull() ?: return
        if (children.containsKey(folder.id) || !listing.add(folder.id)) return
        scope.launch {
            com.hushos.app.data.attempt { withContext(Dispatchers.IO) { v.children(folder.id) } }
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
    var reporting by retain { mutableStateOf(false) }
    var whole by retain { mutableStateOf("") }
    val current = stack.lastOrNull() ?: root
    // A link's secret opens everything behind it: the screen holding it (and what it opened) stays out of captures.
    SecureWindow()
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
                val ok = com.hushos.app.data.attempt { withContext(Dispatchers.IO) { v.download(item, file) { f -> opening = item.id to f } } }.isSuccess
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
                            val ok = file.exists() || com.hushos.app.data.attempt { withContext(Dispatchers.IO) { vault.getOrThrow().download(shown, file) } }.isSuccess
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
                    EmptyState(problem.title, problem.body) {
                        if (problem == LinkTrouble.FAILED) Button(onClick = { session.retry() }) { Text("Try again") }
                        if (problem == LinkTrouble.INCOMPLETE) {
                            // The link's secret is a key: no autocorrect, and nothing the keyboard learns or suggests from it later.
                            NoKeyboardLearning {
                                OutlinedTextField(value = whole, onValueChange = { whole = it }, singleLine = true, label = { Text("Whole link") },
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                            }
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
