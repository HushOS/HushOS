package com.hushos.app.ui

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.LibraryAdd
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Offline
import com.hushos.app.data.Opened
import com.hushos.app.data.VersionListView
import com.hushos.app.data.Vault
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

/* Which part of the item sheet opens first: the menu, or one action straight from the selection bar or Info. */
enum class ItemSheet { MENU, RENAME, MOVE, VERSIONS, TAGS, INFO, SHARE, SEND, REPORT }

/* Whose folder an item sits in: this account's, or someone else's that it can edit or only view. */
enum class Owner { ME, EDIT, VIEW }

/* The share an item of someone else's drive came through: the mount whose root is the item or a folder above it. */
fun receivedVia(model: DriveViewModel, state: DriveState, item: Opened): Vault.ShareMount? {
    val mounts = state.shares.orEmpty().filter { it.root != null }
    var cursor: Opened? = item
    var steps = 0
    while (cursor != null && steps++ < 256) {
        mounts.firstOrNull { it.root?.id == cursor?.id }?.let { return it }
        cursor = cursor.node.parentId?.let { model.item(it) }
    }
    return null
}

fun ownerOf(model: DriveViewModel, state: DriveState, item: Opened): Owner {
    val own = state.rootId?.let { model.item(it) }?.node?.workspaceId
    if (own == null || item.node.workspaceId == own) return Owner.ME
    return if (receivedVia(model, state, item)?.share?.role == "editor") Owner.EDIT else Owner.VIEW
}

/* The second line under an item's name in its sheet: who can open it, in the row's words, or who shared it. */
fun sheetLine(model: DriveViewModel, state: DriveState, item: Opened): String {
    receivedVia(model, state, item)?.let { mount ->
        val from = mount.share.granterName.ifEmpty { mount.share.granterEmail }.split(' ').first()
        return "From $from · ${if (mount.share.role == "editor") "can edit" else "can view"}"
    }
    // Shared, here or through a folder above: everyone, as Info says it. The row's short form
    // ("Anyone with the link", "Same as folder") leaves out the people a link sits beside.
    val who = whoCanOpen(model, state, item)
        ?: return listOfNotNull(whenText(item.modifiedMillis), item.size?.let { formatBytes(it) }).joinToString(" · ")
    if (who == WhoCanOpen.OnlyYou) return who.label()
    return whoCanOpenSentence(model, state, item) ?: who.label()
}

/* The item at the head of a sheet: its mark, its name, and one line about it. */
@Composable
fun ItemHeader(model: DriveViewModel, state: DriveState, item: Opened, subtitle: String? = null, open: Boolean = false) {
    val alpine = Alpine.colors
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    val line = subtitle ?: sheetLine(model, state, item)
    Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S6, end = AlpineSpace.S6, bottom = AlpineSpace.S3), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(56.dp).background(if (bitmap == null) alpine.fill else Color.Transparent, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
            Mark(item, bitmap, box = if (bitmap != null) 56.dp else 38.dp)
        }
        Column(Modifier.padding(start = AlpineSpace.S4)) {
            Text(item.name, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Normal), maxLines = 2, overflow = TextOverflow.Ellipsis)
            // A sheet's header is a detail, not a list row: plain words, no link icon.
            if (line.isNotEmpty()) Text(line, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/* One row of a sheet: an icon and a label, red for the destructive one. */
@Composable
fun SheetRow(label: String, icon: ImageVector, danger: Boolean = false, enabled: Boolean = true, leading: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    val alpine = Alpine.colors
    val color = when { !enabled -> alpine.inkMuted; danger -> alpine.danger; else -> alpine.ink }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(enabled = enabled, onClick = onClick).padding(horizontal = AlpineSpace.S6),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { leading() } else Icon(icon, null, tint = color)
        Text(label, style = MaterialTheme.typography.bodyLarge, color = color, modifier = Modifier.padding(start = AlpineSpace.S4))
    }
}

@Composable
private fun SheetDivider() = HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S1), color = Alpine.colors.divider)

/*
 * The item sheet, from a row's ⋮ or a long press on a tile: the same items, in the same order and words, as
 * iOS and the web. Select first when `onSelect` is given (a tile has no other way in), then get it out (Share, Send a copy, Keep on this phone, or Save a
 * copy from someone else's folder), organise it (Rename, Move, Copy, Tags), learn
 * about it (Versions, Info), Report on others' items, and Move to Trash, last and red.
 */
@Composable
fun ItemActions(model: DriveViewModel, state: DriveState, item: Opened, open: ItemSheet = ItemSheet.MENU, onSelect: (() -> Unit)? = null, dismiss: () -> Unit) {
    var sheet by remember { mutableStateOf(open) }
    val context = LocalContext.current
    val owner = ownerOf(model, state, item)
    val mine = owner == Owner.ME
    val canEdit = owner != Owner.VIEW
    when (sheet) {
        ItemSheet.MENU -> Sheet(onDismissRequest = dismiss) { Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S4)) {
            ItemHeader(model, state, item)
            SheetDivider()
            onSelect?.let { select ->
                SheetRow("Select", Icons.Outlined.CheckCircleOutline) { select(); dismiss() }
                SheetDivider()
            }
            if (mine) SheetRow("Share", Icons.Outlined.PersonAdd) { sheet = ItemSheet.SHARE }
            if (!item.isFolder) SheetRow("Send a copy", Icons.AutoMirrored.Outlined.Send) { sheet = ItemSheet.SEND }
            // The phone copy: keep it, watch it come down (and stop it), or remove it. A folder keeps everything in it,
            // so only folders in this account's drive (a job of the queue's) offer it.
            run {
                val fetching = (state.queued + state.transfers).firstOrNull { it.kind == "keep" && it.node == item.id && !it.done }
                // A file that came with a kept folder goes with that folder, not on its own.
                val failure = if (item.isFolder) null else state.keepFailures.firstOrNull { it.fileId == item.id }
                val keptWith = if (item.isFolder) null else state.keptFolders.firstOrNull { folder -> folder.id == failure?.folderId || state.offline.any { it.id == item.id && it.via == folder.id } }
                    ?: model.keptFolderOf(item, state)
                // A subfolder of a kept folder is kept with it, as its files are.
                val arrived = item.isFolder || state.offline.any { it.id == item.id }
                when {
                    keptWith != null -> {
                        // The rest of the folder is kept; this one says why and can go again now.
                        if (failure != null) {
                            SheetRow("Couldn’t be kept: ${failure.reason}", Icons.Outlined.ErrorOutline, enabled = false) {}
                            SheetRow("Retry", Icons.Outlined.Refresh) { model.retryKept(keptWith.id); dismiss() }
                        } else if (arrived) SheetRow("Kept with “${keptWith.name}”", Icons.Outlined.Smartphone, enabled = false) {}
                        else SheetRow("Keeping with “${keptWith.name}”…", Icons.Outlined.DownloadForOffline, enabled = false) {}
                        SheetRow("Remove “${keptWith.name}” from this phone", Icons.Outlined.RemoveCircleOutline) {
                            model.forgetKeptFolder(keptWith.id); model.notify("Removed “${keptWith.name}” from this phone. It’s still in HushOS."); dismiss()
                        }
                    }
                    fetching != null -> {
                        SheetRow("Downloading… ${(fetching.fraction * 100).toInt()}%", Icons.Outlined.DownloadForOffline, enabled = false,
                            leading = { CircularProgressIndicator(progress = { fetching.fraction }, modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp) }) {}
                        fetching.cancel?.let { cancel -> SheetRow("Stop downloading", Icons.Outlined.StopCircle) { cancel(); dismiss() } }
                    }
                    item.isFolder && state.keptFolders.any { it.id == item.id } -> SheetRow("Remove from this phone", Icons.Outlined.RemoveCircleOutline) {
                        model.setKeptDownloaded(item, false); model.notify("Removed “${item.name}” from this phone. It’s still in HushOS."); dismiss()
                    }
                    !item.isFolder && Offline.isKept(context, item.id) -> SheetRow("Remove from this phone", Icons.Outlined.RemoveCircleOutline) {
                        // The file stays in HushOS, so this acts at once and says so.
                        model.setKeptDownloaded(item, false); model.notify("Removed from this phone. It’s still in HushOS."); dismiss()
                    }
                    else -> SheetRow("Keep on this phone", Icons.Outlined.DownloadForOffline) { model.setKeptDownloaded(item, true); dismiss() }
                }
            }
            if (!mine) SheetRow("Save a copy to my files", Icons.Outlined.LibraryAdd) { model.saveCopy(listOf(item)); dismiss() }
            SheetDivider()
            if (canEdit) SheetRow("Rename", Icons.Outlined.Edit) { sheet = ItemSheet.RENAME }
            if (canEdit) SheetRow("Move", Icons.AutoMirrored.Outlined.DriveFileMove) { sheet = ItemSheet.MOVE }
            SheetRow("Copy", Icons.Outlined.ContentCopy) { model.copy(listOf(item)); dismiss() }
            if (mine) SheetRow("Tags", Icons.AutoMirrored.Outlined.Label) { sheet = ItemSheet.TAGS }
            SheetDivider()
            if (!item.isFolder && canEdit) SheetRow("Versions", Icons.Outlined.History) { sheet = ItemSheet.VERSIONS }
            SheetRow("Info", Icons.Outlined.Info) { sheet = ItemSheet.INFO }
            if (!mine) {
                SheetDivider()
                SheetRow("Report", Icons.Outlined.Flag) { sheet = ItemSheet.REPORT }
            }
            if (canEdit) {
                SheetDivider()
                SheetRow("Move to Trash", Icons.Outlined.Delete, danger = true) { model.trash(item); dismiss() }
            }
        } }
        ItemSheet.RENAME -> RenameDialog(model, state, item, dismiss)
        ItemSheet.MOVE -> MovePicker(model, state, listOf(item), dismiss)
        ItemSheet.VERSIONS -> VersionsSheet(model, state, item, dismiss)
        ItemSheet.TAGS -> ItemTagsSheet(model, state, listOf(item), dismiss)
        ItemSheet.SHARE -> ShareSheet(model, state, item, dismiss)
        ItemSheet.SEND -> SendCopy(model, state, listOf(item), dismiss)
        ItemSheet.INFO -> InfoSheet(model, state, item, onShare = { sheet = ItemSheet.SHARE }, onTags = { sheet = ItemSheet.TAGS }, dismiss = dismiss)
        ItemSheet.REPORT -> ReportSheet(item, model.reportsGoTo(state), dismiss) { category, reason, email -> model.report(item, category, reason, email) }
    }
}

/* Rename: one field, the same clash message as iOS and the web. */
@Composable
fun RenameDialog(model: DriveViewModel, state: DriveState, item: Opened, dismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf(item.name) }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val clean = name.trim()
    val siblings = item.node.parentId?.let { state.folders[it] }.orEmpty()
    val taken = clean != item.name && siblings.any { it.id != item.id && it.name.equals(clean, ignoreCase = true) }
    val error = when { clean.isEmpty() -> "Enter a name."; taken -> "“$clean” is already in this folder. Try another name."; else -> null }
    val save = {
        // The dialog goes with the keyboard: left up, it covers the list the new name lands in.
        keyboard?.hide(); if (clean != item.name) model.rename(item, clean); dismiss()
    }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Rename") },
        text = {
            OutlinedTextField(
                value = name, onValueChange = { name = it }, singleLine = true, label = { Text("Name") }, isError = error != null,
                supportingText = error?.let { { Text(it) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (error == null) save() }),
            )
        },
        confirmButton = { TextButton(enabled = error == null, onClick = save) { Text("Rename") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}

/* A place the picker can move into: this account's folders, and folders others let it edit. */
private data class Place(val id: String?, val name: String, val workspaceId: String?)

/*
 * Move: a full sheet that walks folders from the top, with a trail back up. The
 * top level offers Files and every folder someone shared with edit rights, so a
 * move into (or out of) a shared folder is one path, as Cut and Paste were.
 * Moving into a shared folder says first who will be able to open it there.
 */
@Composable
fun MovePicker(model: DriveViewModel, state: DriveState, items: List<Opened>, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val first = items.first()
    val excluded = items.map { it.id }.toSet()
    // null: the top, where Files and the shared folders sit side by side.
    var trail by remember { mutableStateOf(listOf(Place(state.rootId, "Files", state.rootId?.let { model.item(it) }?.node?.workspaceId))) }
    val here = trail.lastOrNull()
    val folderId = here?.id
    LaunchedEffect(Unit) { if (state.shares == null) model.refreshShares() }
    LaunchedEffect(folderId) { folderId?.let { if (!state.folders.containsKey(it)) model.refresh(it) } }
    val editable = state.shares.orEmpty().filter { it.share.role == "editor" && it.root?.isFolder == true }
    val folders = if (here == null) emptyList() else (folderId?.let { state.folders[it] }?.filter { it.isFolder && it.id !in excluded } ?: emptyList())
    val already = folderId != null && items.all { it.node.parentId == folderId }
    // Who will be able to open it there: this account's people on a shared folder of its own, or the one who shared it.
    val note = folderId?.let { id ->
        val access = state.access
        val target = model.item(id)
        val received = target?.let { receivedVia(model, state, it) }
        when {
            received != null -> "${received.share.granterName.ifEmpty { received.share.granterEmail }} and the people they share it with will be able to open it there."
            target != null && access != null -> sharedAbove(model, access, target, self = true)?.second
                ?.takeIf { who -> items.none { access[it.id]?.shared == true } }
                ?.let { who -> names(who.people.map { it.first } + if (who.links > 0) listOf("anyone with the link") else emptyList()).replaceFirstChar { it.uppercase() } + " will be able to open it there." }
            else -> null
        }
    }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 480.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S2, end = AlpineSpace.S4, bottom = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
                if (trail.size > 1 || here == null) IconButton(onClick = { trail = if (here == null) trail else trail.dropLast(1).ifEmpty { listOf() } }) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Up one folder")
                } else IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, "Close") }
                Column {
                    Text("Move to", style = MaterialTheme.typography.titleLarge)
                    Text(if (items.size == 1) first.name else "${items.size} items", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            // Where you are, as a trail of places to go back to.
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
                if (editable.isNotEmpty()) {
                    TrailChip("All places", current = here == null) { trail = emptyList() }
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted, modifier = Modifier.size(16.dp))
                }
                trail.forEachIndexed { index, place ->
                    if (index > 0) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted, modifier = Modifier.size(16.dp))
                    TrailChip(place.name, current = index == trail.lastIndex) { trail = trail.take(index + 1) }
                }
            }
            Column(Modifier.weight(1f, fill = false).heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                if (here == null) {
                    PlaceRow("Files", "Your own files") { trail = listOf(Place(state.rootId, "Files", state.rootId?.let { model.item(it) }?.node?.workspaceId)) }
                    for (mount in editable) {
                        val root = mount.root ?: continue
                        PlaceRow(root.name, "From ${mount.share.granterName.ifEmpty { mount.share.granterEmail }.split(' ').first()} · can edit") {
                            trail = listOf(Place(root.id, root.name, root.node.workspaceId))
                        }
                    }
                } else if (folderId != null && !state.folders.containsKey(folderId)) {
                    Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                } else if (folders.isEmpty()) {
                    Text("No folders in here.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp))
                } else for (folder in folders) {
                    PlaceRow(folder.name, whoCanOpen(model, state, folder)?.takeIf { it is WhoCanOpen.People || it == WhoCanOpen.AnyoneWithLink }?.label(), mark = folder) { trail = trail + Place(folder.id, folder.name, folder.node.workspaceId) }
                }
            }
            HorizontalDivider(color = alpine.divider)
            Column(Modifier.fillMaxWidth().padding(AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                if (note != null && !already) Text(note, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                Button(
                    enabled = folderId != null && !already,
                    onClick = { folderId?.let { model.moveAll(items, it, here.name) }; dismiss() },
                    modifier = Modifier.fillMaxWidth().height(56.dp),
                ) { Text(if (already) "Already here" else "Move here") }
            }
        }
    }
}

@Composable
private fun TrailChip(label: String, current: Boolean, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Text(
        label, style = MaterialTheme.typography.bodyMedium, fontWeight = if (current) FontWeight.Medium else null,
        color = if (current) alpine.onTint else alpine.primary, maxLines = 1,
        modifier = Modifier.clip(CircleShape).background(if (current) alpine.tint else Color.Transparent).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S2, vertical = AlpineSpace.S1),
    )
}

@Composable
private fun PlaceRow(name: String, detail: String?, mark: Opened? = null, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { FolderMark() }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let { AccessText(it, linked = it == WhoCanOpen.AnyoneWithLink.label()) }
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
    }
}

/*
 * Send a copy: the files are made ready on this phone (saying once, while it
 * prepares, that whoever gets them can open them without HushOS), then the
 * system share sheet takes them. Several files go out together.
 */
@Composable
fun SendCopy(model: DriveViewModel, state: DriveState, items: List<Opened>, dismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf<Opened?>(null) }
    var attempt by remember { mutableStateOf(0) }
    var job by remember { mutableStateOf<Job?>(null) }
    var done by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        failed = null
        done = 0
        job = scope.launch {
            val uris = ArrayList<Uri>()
            for (item in items) {
                val uri = model.download(item, quiet = true)
                if (uri == null) { failed = item; return@launch }
                uris.add(uri)
                done++
            }
            send(context, items, uris)
            dismiss()
        }
    }
    failed?.let { item ->
        AlertDialog(
            onDismissRequest = dismiss,
            title = { Text("Couldn’t prepare “${item.name}”") },
            text = { Text("Check your connection and try again.") },
            confirmButton = { TextButton(onClick = { attempt++ }) { Text("Try again") } },
            dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
        )
        return
    }
    val partial = items.getOrNull(done)?.let { state.opening[it.id] } ?: 0f
    val fraction = (done + partial) / items.size
    AlertDialog(
        onDismissRequest = {},
        title = { Text("Preparing a copy…") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
                Text(if (items.size == 1) "Whoever you send it to can open it without HushOS." else "Whoever you send them to can open them without HushOS.")
                Meter(fraction)
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { job?.cancel(); dismiss() }) { Text("Cancel") } },
    )
}

private fun send(context: Context, items: List<Opened>, uris: List<Uri>) {
    val intent = if (uris.size == 1) Intent(Intent.ACTION_SEND).setType(mimeOf(items[0]) ?: "*/*").putExtra(Intent.EXTRA_STREAM, uris[0])
    else Intent(Intent.ACTION_SEND_MULTIPLE).setType(if (items.map { mimeOf(it)?.substringBefore('/') }.distinct().size == 1) "${mimeOf(items[0])?.substringBefore('/')}/*" else "*/*")
        .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(shareChooser(context, intent, if (items.size == 1) items[0].name else "${items.size} files"))
}

/*
 * Versions: the current one and the earlier one the server keeps for 30 days.
 * An earlier version can be previewed, restored, sent, or deleted (which asks).
 */
@Composable
fun VersionsSheet(model: DriveViewModel, state: DriveState, item: Opened, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    var versions by remember { mutableStateOf<List<VersionListView>?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sizes by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var menu by remember { mutableStateOf<VersionListView?>(null) }
    var deleting by remember { mutableStateOf<VersionListView?>(null) }
    var restoring by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf<VersionListView?>(null) }
    var reload by remember { mutableStateOf(0) }
    val current = model.item(item.id) ?: item
    LaunchedEffect(item.id, reload) {
        versions = model.versions(current)
        // Sizes are sealed in each version's envelope, so they are opened here rather than read off the list.
        sizes = model.versionSizes(current, versions.orEmpty())
    }
    val when_ = { v: VersionListView -> runCatching { whenText(Instant.parse(v.createdAt).toEpochMilli()) }.getOrNull() ?: v.createdAt }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().heightIn(min = 400.dp).verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S2, end = AlpineSpace.S4, bottom = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, "Close") }
                Column {
                    Text("Versions", style = MaterialTheme.typography.titleLarge)
                    Text(item.name, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val list = versions
            if (list == null) { Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return@Column }
            Subheader("Current version")
            list.filter { it.current }.forEach { v -> VersionRow(item, when_(v), listOfNotNull(sizes[v.id]?.let { formatBytes(it) }).joinToString(" · ").ifEmpty { null }) }
            val earlier = list.filter { !it.current }
            Subheader(if (earlier.size > 1) "Earlier versions" else "Earlier version")
            if (earlier.isEmpty()) Text("No earlier version. When you replace this file, the old one waits here for 30 days.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S3))
            for (v in earlier) {
                val left = v.supersededAt?.let { runCatching { 30 - ChronoUnit.DAYS.between(Instant.parse(it), Instant.now()) }.getOrNull() }?.coerceAtLeast(0)
                val detail = when {
                    restoring == v.id -> "Restoring…"
                    v.status != "ready" -> "Not ready yet"
                    else -> listOfNotNull(sizes[v.id]?.let { formatBytes(it) }, left?.let { if (it == 1L) "deleted in 1 day" else "deleted in $it days" }).joinToString(" · ")
                }
                VersionRow(item, when_(v), detail, faded = true, onClick = if (v.status == "ready" && restoring == null) ({ menu = v }) else null) {
                    if (restoring == v.id) CircularProgressIndicator(Modifier.padding(end = 12.dp).size(24.dp), strokeWidth = 2.5.dp)
                    else if (v.status == "ready") Box {
                        IconButton(onClick = { menu = v }) { Icon(Icons.Outlined.MoreVert, "More for the earlier version") }
                        DropdownMenu(expanded = menu?.id == v.id, onDismissRequest = { menu = null }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                            DropdownMenuItem(text = { Text("Preview") }, leadingIcon = { Icon(Icons.Outlined.Visibility, null) }, onClick = {
                                menu = null
                                scope.launch { model.download(current, v)?.let { openWith(context, it, mimeOf(item), model, item.name) } }
                            })
                            DropdownMenuItem(text = { Text("Restore") }, leadingIcon = { Icon(Icons.Outlined.Restore, null) }, onClick = {
                                menu = null; restoring = v.id
                                scope.launch {
                                    val ok = model.restoreVersionNow(v, current)
                                    restoring = null
                                    if (ok) { model.notify("Earlier version restored. The one it replaced is now the earlier version."); reload++ }
                                }
                            })
                            DropdownMenuItem(text = { Text("Send a copy") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Send, null) }, onClick = { menu = null; sending = v })
                            DropdownMenuItem(text = { Text("Delete earlier version", color = alpine.danger) }, leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = alpine.danger) }, onClick = { menu = null; deleting = v })
                        }
                    }
                }
            }
            if (earlier.isNotEmpty()) Text("When you replace a file, the version it replaced stays here for 30 days.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
                modifier = Modifier.padding(start = AlpineSpace.S4, end = AlpineSpace.S4, top = AlpineSpace.S4))
        }
    }
    deleting?.let { v ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete the earlier version?") },
            text = { Text("It’s deleted for good${sizes[v.id]?.let { " and its ${formatBytes(it)} is freed" } ?: ""}. The current version isn’t touched.") },
            confirmButton = { TextButton(onClick = {
                deleting = null
                scope.launch { if (model.discardVersion(current, v)) { model.notify("Earlier version deleted"); reload++ } }
            }) { Text("Delete version", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
    sending?.let { v ->
        LaunchedEffect(v.id) {
            model.download(current, v)?.let { send(context, listOf(item), listOf(it)) }
            sending = null
        }
    }
}

@Composable
private fun VersionRow(item: Opened, title: String, detail: String?, faded: Boolean = false, onClick: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    val alpine = Alpine.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(start = AlpineSpace.S4),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).alpha(if (faded) 0.7f else 1f), contentAlignment = Alignment.Center) { Mark(item, null) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp, end = AlpineSpace.S4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted) }
        }
        trailing?.invoke()
    }
}

/* Info: what it is, and who can open it and its tags as ways in, not dead text. */
@Composable
fun InfoSheet(model: DriveViewModel, state: DriveState, item: Opened, onShare: () -> Unit, onTags: () -> Unit, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    val mine = ownerOf(model, state, item) == Owner.ME
    val created = item.node.createdAt?.let { runCatching { whenText(Instant.parse(it).toEpochMilli()) }.getOrNull() }
    val folder = item.node.parentId?.let { parent -> if (parent == state.rootId) "Files" else model.item(parent)?.name }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S6)) {
            Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S4), horizontalAlignment = Alignment.CenterHorizontally) {
                Mark(item, bitmap, box = if (bitmap != null) 120.dp else 88.dp)
                Text(item.name, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S3))
            }
            Fact("Kind", kindOf(item))
            item.size?.let { Fact("Size", formatBytes(it)) }
            whenText(item.modifiedMillis)?.let { Fact("Changed", it) }
            created?.let { Fact("Created", it) }
            folder?.let { Fact("Folder", it, primary = true) }
            SheetDivider()
            // Who can open it, in words (never "Same as folder"), once it is known; it opens the share sheet.
            // Who can open it, as a whole sentence with you first; it opens the share sheet.
            whoCanOpenSentence(model, state, item)?.let { who -> Fact("Who can open", who, onClick = if (mine) onShare else null) }
            if (mine) {
                val tags = state.tags.tagsOf(item.id)
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onTags).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                    Text("Tags", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    if (tags.isEmpty()) Text("None", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    else Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S1)) { for (tag in tags.take(3)) TagPill(tag) }
                }
            }
        }
    }
}

/*
 * A label and its value. A short value sits beside the label; a sentence ("You, Sam and anyone
 * with the link") goes on its own line under it, whole, never cut. No link icon here: that is
 * for list rows, where space is short. A tappable one has a chevron.
 */
@Composable
private fun Fact(label: String, value: String, primary: Boolean = false, onClick: (() -> Unit)? = null) {
    val alpine = Alpine.colors
    val color = if (primary) alpine.primary else alpine.inkMuted
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = AlpineSpace.S4),
        verticalAlignment = Alignment.CenterVertically) {
        if (value.length <= 18) {
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End, color = color,
                fontWeight = if (primary) FontWeight.Medium else null, modifier = Modifier.padding(start = AlpineSpace.S4))
        } else Column(Modifier.weight(1f).padding(vertical = AlpineSpace.S2)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(value, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = if (primary) FontWeight.Medium else null)
        }
        if (onClick != null) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted, modifier = Modifier.padding(start = AlpineSpace.S2))
    }
}

/*
 * Tags for one item or several: a find-or-add field, each tag with a box (mixed
 * when only some of the items carry it), and Manage tags for the whole list.
 */
@Composable
fun ItemTagsSheet(model: DriveViewModel, state: DriveState, items: List<Opened>, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    // Tag id to on (true), off (false), or left as each item has it (null).
    var choice by remember { mutableStateOf<Map<String, Boolean?>>(emptyMap()) }
    var query by rememberSaveable { mutableStateOf("") }
    var colour by rememberSaveable { mutableStateOf(OFFERED_TAG_COLOURS.first()) }
    var managing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.refreshTags() }
    val carried = { tagId: String -> items.count { tagId in state.tags.tagsOf(it.id).map { t -> t.id } } }
    val stateOf = { tagId: String ->
        when (choice[tagId]) {
            true -> ToggleableState.On
            false -> ToggleableState.Off
            null -> when (carried(tagId)) { 0 -> ToggleableState.Off; items.size -> ToggleableState.On; else -> ToggleableState.Indeterminate }
        }
    }
    val typed = query.trim()
    val shown = state.tags.tags.filter { it.name.contains(typed, ignoreCase = true) }
    val add = {
        if (typed.isNotEmpty()) {
            val name = typed; query = ""
            model.editTags { registry -> val tag = registry.add(name, colour); choice = choice + (tag.id to true) }
        }
    }
    if (managing) { TagManagerSheet(model, state) { managing = false }; return }
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S4)) {
            if (items.size == 1) ItemHeader(model, state, items[0], subtitle = "Tags")
            else Text("Tags for ${items.size} items", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
            Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6), verticalAlignment = Alignment.CenterVertically) {
                TextField(
                    value = query, onValueChange = { query = it }, singleLine = true, placeholder = { Text("Find or add a tag") },
                    leadingIcon = { Icon(Icons.Outlined.Search, null, tint = alpine.inkMuted) }, shape = CircleShape,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { add() }),
                    colors = TextFieldDefaults.colors(focusedContainerColor = alpine.fill, unfocusedContainerColor = alpine.fill, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                    modifier = Modifier.weight(1f).then(if (alpine.high) Modifier.border(1.dp, alpine.field, CircleShape) else Modifier),
                )
                FilledTonalButton(enabled = typed.isNotEmpty(), onClick = add, modifier = Modifier.padding(start = AlpineSpace.S2)) { Text("Add") }
            }
            // The colour a new tag gets.
            Row(Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                for (c in OFFERED_TAG_COLOURS) Swatch(c, selected = colour == c) { colour = c }
            }
            if (shown.none { it.name.equals(typed, ignoreCase = true) } && typed.isNotEmpty()) SheetRow("Add “$typed”", Icons.Outlined.Add) { add() }
            for (tag in shown) {
                val on = stateOf(tag.id)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).background(if (on == ToggleableState.On) alpine.tint else Color.Transparent)
                        .clickable(role = Role.Checkbox) { choice = choice + (tag.id to (on != ToggleableState.On)) }.padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    androidx.compose.material3.TriStateCheckbox(state = on, onClick = null)
                    TagDot(tag.colour, 10.dp)
                    Text(tag.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f).padding(start = AlpineSpace.S2))
                    Text("${state.tags.nodesWith(tag.id).size}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
            }
            Text("Only you see your tags. People you share with don’t.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S3))
            Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { managing = true }) { Text("Manage tags") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = dismiss) { Text("Cancel") }
                Button(onClick = {
                    val changes = choice.filterValues { it != null }
                    if (changes.isNotEmpty()) model.editTags { registry ->
                        for (item in items) {
                            val now = registry.tagsOf(item.id).map { it.id }.toMutableSet()
                            for ((id, on) in changes) if (on == true) now.add(id) else now.remove(id)
                            registry.assign(item.id, now)
                        }
                    }
                    dismiss()
                }) { Text("Save") }
            }
        }
    }
}

/* A round tag colour to choose, with a check on the chosen one. */
@Composable
fun Swatch(colour: String, selected: Boolean, size: androidx.compose.ui.unit.Dp = 36.dp, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Box(
        Modifier.size(size).then(if (selected) Modifier.border(2.dp, alpine.ink, CircleShape) else Modifier).padding(4.dp)
            .clip(CircleShape).background(tagColour(colour)).clickable(role = Role.RadioButton, onClickLabel = colour, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { if (selected) Icon(Icons.Outlined.Check, null, tint = onTagColour(colour), modifier = Modifier.size(size * 0.45f)) }
}

/*
 * Tag yellow and the ink that reads on it, the web's own values (apps/web/src/styles.css,
 * --tag-yellow / --on-tag-yellow) in its four schemes, so a yellow tag is the same yellow
 * on every client rather than the warning colour.
 */
private object TagYellow {
    val light = Color(0xFFB8860B) to Color(0xFF17203A)
    val dark = Color(0xFFE3B341) to Color(0xFF121833)
    val highLight = Color(0xFF6B4D00) to Color(0xFFFFFFFF)
    val highDark = Color(0xFFFFD966) to Color(0xFF000000)

    fun of(dark: Boolean, high: Boolean) = when {
        high && dark -> highDark
        high -> highLight
        dark -> this.dark
        else -> light
    }
}

/* The ink for a mark drawn on a tag's colour: tag yellow has its own; the rest take the surface. */
@Composable
fun onTagColour(value: String): Color {
    val alpine = Alpine.colors
    return if (value == "yellow") TagYellow.of(alpine.dark, alpine.high).second else alpine.surface
}

/*
 * A tag's colour: the presets the web offers (blue and ink follow the theme; teal
 * and coral are the web's swatches; yellow is the web's tag yellow, its own colour
 * rather than the warning), or the hex a person picked.
 */
@Composable
fun tagColour(value: String): Color {
    val alpine = Alpine.colors
    return when (value) {
        "blue" -> alpine.primary
        "ink" -> alpine.ink
        "yellow" -> TagYellow.of(alpine.dark, alpine.high).first
        "teal" -> Color(0xFF23766D)
        "coral" -> Color(0xFFB4503B)
        else -> value.removePrefix("#").toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: alpine.inkMuted
    }
}

/* The colours a tag can be given here, as the web offers them; anything else is a custom colour. */
val OFFERED_TAG_COLOURS = com.hushos.app.data.TagRegistry.OFFERED

/* What a file is, the way people say it: "PNG image", "PDF document", not a MIME type. */
fun kindOf(item: Opened): String {
    if (item.isFolder) return "Folder"
    val mime = mimeOf(item) ?: ""
    val ext = item.name.substringAfterLast('.', "").uppercase().takeIf { it.isNotEmpty() && it.length <= 5 }
    return when {
        mime == "application/pdf" -> "PDF document"
        mime.startsWith("image/") -> "${ext ?: "Image"}${if (ext != null) " image" else ""}"
        mime.startsWith("video/") -> "${ext ?: "Video"}${if (ext != null) " video" else ""}"
        mime.startsWith("audio/") -> "${ext ?: "Audio"}${if (ext != null) " audio" else ""}"
        mime.startsWith("text/") -> "${ext ?: "Text"}${if (ext != null) " text" else ""}"
        mime.contains("zip") || mime.contains("compressed") -> "${ext ?: ""} archive".trim()
        ext != null -> "$ext file"
        else -> "File"
    }
}
