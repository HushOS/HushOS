package com.hushos.app.ui

import androidx.compose.ui.draw.clip
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.heightIn
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Search
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TextField
import androidx.compose.material3.FilterChip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentCut
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButtonMenu
import androidx.compose.material3.FloatingActionButtonMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SearchBar
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material.icons.outlined.Contacts
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.TextButton
import androidx.compose.material3.ToggleFloatingActionButton
import androidx.compose.material3.ToggleFloatingActionButtonDefaults.animateIcon
import androidx.compose.foundation.layout.offset
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Check
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.material3.LinearProgressIndicator
import com.hushos.tokens.AlpineSpace
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.app.data.SharedByMe
import kotlinx.coroutines.launch

/* Opens a decrypted file with whatever app handles its type. */
fun openWith(context: android.content.Context, uri: android.net.Uri, mime: String?, model: DriveViewModel? = null, name: String? = null) {
    val type = name?.let { mimeFor(it, mime) } ?: mime
    // Straight to the app Android picks for this type: the person's default, or Android's own
    // "Just once / Always" when there is none, so a default sticks.
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type ?: "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    // A kind nobody named (no type, or raw bytes) counts as none: apps that claim raw bytes (Google
    // Wallet's pass importer, for one) take the file and close without a word.
    val unknown = type == null || type == "application/octet-stream"
    if (model != null && unknown) { model.noApp(name ?: "this file", uri, type); return }
    try {
        context.startActivity(intent)
    } catch (error: android.content.ActivityNotFoundException) {
        // No app for this kind: HushOS says so and offers Send a copy, not the system's bare "No apps can perform this action".
        model?.noApp(name ?: "this file", uri, type)
    }
}

/* Every tag in the workspace: rename, recolour, remove (which asks first), and how many items each names. */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun TagManagerSheet(model: DriveViewModel, state: DriveState, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    var newName by rememberSaveable { mutableStateOf("") }
    var renaming by remember { mutableStateOf<com.hushos.app.data.Tag?>(null) }
    var renameDraft by rememberSaveable { mutableStateOf("") }
    var deleting by remember { mutableStateOf<com.hushos.app.data.Tag?>(null) }
    var colouring by remember { mutableStateOf<com.hushos.app.data.Tag?>(null) }
    LaunchedEffect(Unit) { model.refreshTags() }
    Sheet(onDismissRequest = dismiss) {
        Text("Tags", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = newName, onValueChange = { newName = it }, singleLine = true, label = { Text("New tag") }, modifier = Modifier.weight(1f))
            androidx.compose.material3.FilledTonalButton(enabled = newName.isNotBlank(), onClick = { val name = newName; newName = ""; model.editTags { it.add(name) } }, modifier = Modifier.padding(start = 8.dp)) { Text("Add") }
        }
        if (state.tags.tags.isEmpty()) Text("No tags yet. Tags group items across folders.", color = alpine.inkMuted, modifier = Modifier.padding(24.dp))
        LazyColumn {
            items(state.tags.tags, key = { it.id }) { tag ->
                val count = state.tags.nodesWith(tag.id).size
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { colouring = tag }) { TagDot(tag.colour, 18.dp) }
                    Column(Modifier.weight(1f).padding(start = 4.dp)) {
                        Text(tag.name, style = MaterialTheme.typography.bodyLarge)
                        Text(if (count == 1) "1 item" else "$count items", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                    IconButton(onClick = { renameDraft = tag.name; renaming = tag }) { Icon(androidx.compose.material.icons.Icons.Outlined.Edit, "Rename ${tag.name}") }
                    IconButton(onClick = { deleting = tag }) { Icon(androidx.compose.material.icons.Icons.Outlined.Delete, "Remove ${tag.name}") }
                }
            }
            item {
                Text("Tags are only for you: people you share with never see them.",
                    style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(24.dp))
            }
        }
    }
    colouring?.let { tag -> ColourDialog(tag.name, current = tag.colour, onPick = { colour -> colouring = null; model.editTags { it.recolour(tag.id, colour) } }, onDismiss = { colouring = null }) }
    renaming?.let { tag ->
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename tag") },
            text = {
                Column {
                    Text("The new name shows everywhere at once.", modifier = Modifier.padding(bottom = 12.dp))
                    OutlinedTextField(value = renameDraft, onValueChange = { renameDraft = it }, singleLine = true, label = { Text("Name") })
                }
            },
            confirmButton = { TextButton(enabled = renameDraft.isNotBlank(), onClick = { val name = renameDraft; renaming = null; model.editTags { it.rename(tag.id, name) } }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }
    deleting?.let { tag ->
        val count = state.tags.nodesWith(tag.id).size
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Remove “${tag.name}”?") },
            text = { Text("The tag comes off ${if (count == 1) "1 item" else "$count items"} and leaves your list. The items themselves aren’t touched.") },
            confirmButton = { TextButton(onClick = { deleting = null; model.editTags { it.remove(tag.id) } }) { Text("Remove tag", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/* The presets the web offers, as round swatches with a check, or a custom colour typed as a hex. */
@Composable
fun ColourDialog(name: String, current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val alpine = Alpine.colors
    var choice by rememberSaveable { mutableStateOf(current) }
    var hex by rememberSaveable { mutableStateOf(if (current.startsWith("#")) current else "") }
    val valid = choice in OFFERED_TAG_COLOURS || Regex("^#[0-9a-fA-F]{6}$").matches(choice)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Tag colour") },
        text = {
            Column {
                Text("For “$name”", modifier = Modifier.padding(bottom = 16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (colour in OFFERED_TAG_COLOURS) {
                        val on = colour == choice
                        Box(
                            Modifier.size(44.dp)
                                .then(if (on) Modifier.border(2.dp, alpine.ink, CircleShape) else Modifier)
                                .padding(4.dp).background(tagColour(colour), CircleShape).clip(CircleShape)
                                .selectable(selected = on, role = androidx.compose.ui.semantics.Role.RadioButton) { choice = colour; hex = "" }
                                .semantics { contentDescription = colour.replaceFirstChar { it.uppercase() } },
                            contentAlignment = Alignment.Center,
                        ) { if (on) Icon(Icons.Outlined.Check, null, tint = onTagColour(colour), modifier = Modifier.size(20.dp)) }
                    }
                }
                OutlinedTextField(
                    value = hex, onValueChange = { hex = it.trim(); if (Regex("^#[0-9a-fA-F]{6}$").matches(hex)) choice = hex.lowercase() },
                    singleLine = true, label = { Text("Custom colour") }, placeholder = { Text("#7c5cbf") },
                    leadingIcon = { if (choice.startsWith("#")) TagDot(choice, 18.dp) },
                    modifier = Modifier.padding(top = 16.dp).fillMaxWidth(),
                )
            }
        },
        confirmButton = { TextButton(enabled = valid, onClick = { onPick(choice) }) { Text("Use colour") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/*
 * Trash, as the board draws it on every client: a line saying how long things
 * stay, rows saying where each was and when it went, a tap for the item's sheet
 * (Restore, or Restore to Files when its folder is gone, and Delete forever,
 * which asks), long press to select, and Empty Trash, which asks with the count.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(model: DriveViewModel, state: DriveState, onBack: (() -> Unit)? = null) {
    val alpine = Alpine.colors
    var confirmEmpty by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf<com.hushos.app.data.TrashItem?>(null) }
    var deleting by remember { mutableStateOf<com.hushos.app.data.TrashItem?>(null) }
    // Rows picked to restore or delete together; a long press starts it, as in Files.
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    var confirmMany by rememberSaveable { mutableStateOf(false) }
    val ids = state.trash.map { it.item.id }.toSet()
    // Rows restored or deleted, here or elsewhere, leave the selection.
    LaunchedEffect(ids) { picked = picked intersect ids }
    val chosen = state.trash.filter { it.item.id in picked }
    BackHandler(enabled = picked.isNotEmpty()) { picked = emptySet() }
    LaunchedEffect(Unit) { model.refreshTrash() }
    // A partial restore's banner lasts while Trash is open: leaving clears it, a rotation or a theme change doesn't.
    val activity = LocalContext.current.let { generateSequence(it) { c -> (c as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull() }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { if (activity?.isChangingConfigurations != true) model.clearRestoreProblem() } }
    Scaffold(contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0), topBar = {
        if (picked.isNotEmpty()) TopAppBar(
            title = { Text("${picked.size} selected") },
            navigationIcon = { IconButton(onClick = { picked = emptySet() }) { Icon(Icons.Outlined.Close, "Done") } },
            actions = {
                val busy = state.trashWorking.isNotEmpty()
                if (picked.size < state.trash.size) IconButton(enabled = !busy, onClick = { picked = ids }) { Icon(Icons.Outlined.Checklist, "Select all") }
                IconButton(enabled = !busy, onClick = { model.restoreMany(chosen); picked = emptySet() }) { Icon(Icons.Outlined.Restore, "Restore") }
                IconButton(enabled = !busy, onClick = { confirmMany = true }) { Icon(Icons.Outlined.DeleteForever, "Delete forever") }
            },
        ) else DestinationBar("Trash", onBack = onBack) {
            if (!state.emptyingTrash && state.trash.isNotEmpty()) TextButton(onClick = { confirmEmpty = true }) { Text("Empty Trash") }
        }
    }) { padding ->
        Column(Modifier.padding(padding)) {
        if (state.unreachable) OfflineCapsule()
        PullToRefreshBox(isRefreshing = state.refreshingTrash, onRefresh = { model.refreshTrash(pulled = true) }, modifier = Modifier.weight(1f)) {
            if (state.trash.isEmpty()) EmptyState("Trash is empty", "Items you move to the Trash stay here for 30 days.", icon = Icons.Outlined.Delete,
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()))
            else LazyColumn(Modifier.fillMaxSize()) {
                // Emptying: the count and a bar under the top bar; otherwise how long things stay.
                val emptying = state.emptying
                if (emptying != null) item(key = "emptying") {
                    Column(Modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S3).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                        verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                        Row(Modifier.fillMaxWidth()) {
                            Text("Emptying the Trash…", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                            Text("${emptying.first} of ${emptying.second}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                        }
                        LinearProgressIndicator(progress = { if (emptying.second == 0) 1f else emptying.first / emptying.second.toFloat() }, modifier = Modifier.fillMaxWidth(),
                            color = alpine.primary, trackColor = alpine.tint, drawStopIndicator = {})
                    }
                } else item(key = "retention") {
                    Text("Items stay here for 30 days, then they’re deleted for good.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
                        modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
                }
                state.restoreProblem?.let { problem ->
                    item(key = "restore-problem") {
                        RestoreProblemBanner(problem, retry = { model.restoreMany(problem.failed.map { it.first }) }, dismiss = model::clearRestoreProblem)
                    }
                }
                items(state.trash, key = { it.item.id }) { entry ->
                    // Mid-way through a restore or delete, or while the whole trash empties, a row takes no second action;
                    // only the row being deleted spins.
                    val spinning = entry.item.id in state.trashWorking
                    val failed = state.restoreProblem?.failed?.any { it.first.item.id == entry.item.id } == true
                    val working = state.emptyingTrash || spinning
                    val toggle = { picked = if (entry.item.id in picked) picked - entry.item.id else picked + entry.item.id }
                    NodeRow(
                        model, state, entry.item,
                        onClick = { if (!working) { if (picked.isNotEmpty()) toggle() else selected = entry } },
                        onLongClick = { if (!working) toggle() },
                        note = if (failed) "Couldn’t be restored" else trashLine(entry), noteIsProblem = failed, working = spinning, selected = entry.item.id in picked,
                    )
                }
            }
        }
        }
    }
    selected?.let { entry ->
        Sheet(onDismissRequest = { selected = null }) {
            Column(Modifier.padding(bottom = AlpineSpace.S4)) {
                ItemHeader(model, state, entry.item, subtitle = trashLine(entry))
                HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S1), color = alpine.divider)
                TrashSheetRow(
                    if (entry.parentTrashed) "Restore to Files" else "Restore",
                    if (entry.parentTrashed) "Its folder “${entry.wasIn ?: "its folder"}” is in the Trash too." else entry.wasIn?.let { "Back to $it" },
                    Icons.Outlined.Restore,
                ) { model.restore(entry); selected = null }
                TrashSheetRow("Delete forever", null, Icons.Outlined.DeleteForever, danger = true) { deleting = entry; selected = null }
            }
        }
    }
    deleting?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete “${entry.item.name}” forever?") },
            text = { Text(if (entry.item.isFolder) "Everything inside goes too. It can’t be restored after this." else "It can’t be restored after this.") },
            confirmButton = { TextButton(onClick = { model.purge(entry); deleting = null }) { Text("Delete forever", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
    if (confirmMany) {
        AlertDialog(
            onDismissRequest = { confirmMany = false },
            title = { Text(if (chosen.size == 1) "Delete “${chosen[0].item.name}” forever?" else "Delete ${chosen.size} items forever?") },
            text = { Text(if (chosen.size == 1) "It can’t be restored after this." else "They can’t be restored after this.") },
            confirmButton = { TextButton(onClick = { model.purgeMany(chosen); confirmMany = false; picked = emptySet() }) { Text("Delete forever", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { confirmMany = false }) { Text("Cancel") } },
        )
    }
    if (confirmEmpty) {
        AlertDialog(
            onDismissRequest = { confirmEmpty = false },
            title = { Text("Empty the Trash?") },
            text = { Text(if (state.trash.size == 1) "The 1 item in it is deleted for good. This can’t be undone." else "All ${state.trash.size} items are deleted for good. This can’t be undone.") },
            confirmButton = { TextButton(onClick = { model.emptyTrash(); confirmEmpty = false }) { Text("Empty Trash", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { confirmEmpty = false }) { Text("Cancel") } },
        )
    }
}

/*
 * A batch restore that partly failed, as the board draws it: it stays until dismissed,
 * saying what came back, what didn't and why, what to do, and where an orphan went.
 */
@Composable
private fun RestoreProblemBanner(problem: RestoreProblem, retry: () -> Unit, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val shape = RoundedCornerShape(16.dp)
    val why = if (problem.offline) " because the connection dropped. Try again once you’re back online." else ". " + (problem.failed.firstOrNull()?.second ?: "Try again.")
    val failedLine = (if (problem.failed.size == 1) "“${problem.failed[0].first.item.name}” couldn’t be restored" else "${problem.failed.size} items couldn’t be restored") + why
    val movedLine = problem.moved.firstOrNull()?.let { (item, folder) ->
        if (problem.moved.size == 1) "“${item.name}” went back to Files, because its folder${folder?.let { " “$it”" } ?: ""} is still in the Trash."
        else "${problem.moved.size} items went back to Files, because their folders are still in the Trash."
    }
    Column(
        Modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S2).fillMaxWidth()
            .background(alpine.dangerSoft, shape)
            .then(if (alpine.high) Modifier.border(1.dp, alpine.edge, shape) else Modifier)
            .semantics(mergeDescendants = false) { liveRegion = LiveRegionMode.Polite }
            .padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S4, bottom = AlpineSpace.S2),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Restored ${problem.restored} of ${problem.total}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = alpine.danger)
        Text(failedLine, style = MaterialTheme.typography.bodyMedium, color = alpine.ink, modifier = Modifier.padding(end = AlpineSpace.S2))
        movedLine?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(end = AlpineSpace.S2)) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2, Alignment.End)) {
            TextButton(onClick = dismiss) { Text("Dismiss") }
            androidx.compose.material3.FilledTonalButton(onClick = retry) { Text("Try again") }
        }
    }
}

/* "Was in Work · Trashed today": where it was and when it went, so Restore isn't a guess. */
private fun trashLine(entry: com.hushos.app.data.TrashItem): String {
    val trashed = entry.item.node.trashedAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
        ?.let { whenText(it) }?.let { if (it.startsWith("Today")) "today" else if (it == "Yesterday") "yesterday" else it }
    return listOfNotNull(entry.wasIn?.let { "Was in $it" }, trashed?.let { "Trashed $it" }).joinToString(" · ")
}

/* A trashed item's sheet row: the action and, under it, where it goes. */
@Composable
private fun TrashSheetRow(label: String, detail: String?, icon: androidx.compose.ui.graphics.vector.ImageVector, danger: Boolean = false, onClick: () -> Unit) {
    val alpine = Alpine.colors
    val color = if (danger) alpine.danger else alpine.ink
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = color)
        Column(Modifier.padding(start = AlpineSpace.S4)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, color = color)
            detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted) }
        }
    }
}

fun sortLabel(key: String) = when (key) { "modified" -> "Changed"; "size" -> "Size"; else -> "Name" }

/* Orders a folder's items by `key`; folders come first whichever key is chosen, as every drive does it. */
fun sortItems(items: List<Opened>, key: String, ascending: Boolean): List<Opened> {
    val byName = compareBy(String.CASE_INSENSITIVE_ORDER) { it: Opened -> it.name }.thenBy { it.id }
    val byKey: Comparator<Opened> = when (key) {
        "modified" -> compareBy<Opened> { it.modifiedMillis ?: Long.MIN_VALUE }.then(byName)
        "size" -> compareBy<Opened> { it.size ?: 0L }.then(byName)
        else -> byName
    }
    return items.sortedWith(compareBy<Opened> { !it.isFolder }.then(if (ascending) byKey else byKey.reversed()))
}
