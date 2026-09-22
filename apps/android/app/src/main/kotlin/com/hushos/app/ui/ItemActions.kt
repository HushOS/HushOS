package com.hushos.app.ui

import android.content.Intent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentCut
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Label
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Check
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.app.data.Offline
import com.hushos.app.data.VersionListView
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.time.Instant
import java.util.Date

private enum class Sheet { MENU, RENAME, MOVE, VERSIONS, TAGS, INFO, LINKS }

/* What long-pressing a node offers, and the dialogs that carry each action out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemActions(model: DriveViewModel, state: DriveState, item: Opened, onSelect: (() -> Unit)? = null, dismiss: () -> Unit) {
    var sheet by remember { mutableStateOf(Sheet.MENU) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    when (sheet) {
        Sheet.MENU -> ModalBottomSheet(onDismissRequest = dismiss) { Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(item.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            HorizontalDivider()
            if (onSelect != null) Action("Select", Icons.Outlined.Checklist) { onSelect(); dismiss() }
            Action("Rename", Icons.Outlined.Edit) { sheet = Sheet.RENAME }
            if (!item.isFolder) {
                val kept = Offline.isKept(context, item.id)
                Action(if (kept) "Remove download" else "Keep downloaded", if (kept) Icons.Outlined.CloudOff else Icons.Outlined.DownloadForOffline) { model.setKeptDownloaded(item, !kept); dismiss() }
            }
            Action("Copy", Icons.Outlined.ContentCopy) { model.copy(listOf(item)); dismiss() }
            Action("Cut", Icons.Outlined.ContentCut) { model.cut(listOf(item)); dismiss() }
            Action("Move to…", Icons.Outlined.DriveFileMove) { sheet = Sheet.MOVE }
            Action("Share", Icons.Outlined.Link) { sheet = Sheet.LINKS }
            if (!item.isFolder) {
                Action("Send a copy", Icons.Outlined.Share) {
                    dismiss()
                    scope.launch {
                        model.download(item)?.let { uri ->
                            val send = Intent(Intent.ACTION_SEND).setType(mimeOf(item) ?: "*/*").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            context.startActivity(Intent.createChooser(send, item.name))
                        }
                    }
                }
                Action("Versions", Icons.Outlined.History) { sheet = Sheet.VERSIONS }
            }
            Action("Tags", Icons.Outlined.Label) { sheet = Sheet.TAGS }
            Action("Info", Icons.Outlined.Info) { sheet = Sheet.INFO }
            HorizontalDivider()
            Action("Move to trash", Icons.Outlined.Delete, destructive = true) { model.trash(item); dismiss() }
        } }
        Sheet.RENAME -> {
            var name by rememberSaveable { mutableStateOf(item.name) }
            AlertDialog(
                onDismissRequest = dismiss,
                title = { Text("Rename") },
                text = { OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, label = { Text("Name") }) },
                confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { if (name.trim() != item.name) model.rename(item, name.trim()); dismiss() }) { Text("Save") } },
                dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
            )
        }
        Sheet.MOVE -> MovePicker(model, state, item, dismiss)
        Sheet.VERSIONS -> VersionsSheet(model, item, dismiss)
        Sheet.TAGS -> TagsSheet(model, state, item, dismiss)
        Sheet.LINKS -> LinkSheet(model, item, dismiss)
        Sheet.INFO -> ModalBottomSheet(onDismissRequest = dismiss) {
            Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
                Text(item.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 8.dp))
                HorizontalDivider(Modifier.padding(bottom = 4.dp))
                Detail("Kind", if (item.isFolder) "Folder" else mimeOf(item) ?: "File")
                item.size?.let { Detail("Size", formatBytes(it)) }
                item.modifiedMillis?.let { Detail("Modified", DateFormat.getDateTimeInstance(DateFormat.LONG, DateFormat.SHORT).format(Date(it))) }
                Detail("Key epoch", item.node.keyEpoch.toString())
                item.node.currentVersion?.let { Detail("Content suite", it.contentSuite.toString()); Detail("Chunks", it.chunkCount.toString()) }
                Text("Names, sizes and contents are sealed on this device. The server stores only ciphertext and the shape of the tree.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
            }
        }
    }
}

@Composable
private fun Action(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, destructive: Boolean = false, onClick: () -> Unit) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    ListItem(
        headlineContent = { Text(label, color = color) },
        leadingContent = { Icon(icon, contentDescription = null, tint = color) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

@Composable
private fun Detail(label: String, value: String) {
    androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.padding(start = 16.dp))
    }
}

/* Pick a destination folder by walking the tree from the root. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MovePicker(model: DriveViewModel, state: DriveState, item: Opened, dismiss: () -> Unit) =
    MovePickerMany(model, state, listOf(item), dismiss)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MovePickerMany(model: DriveViewModel, state: DriveState, items: List<Opened>, dismiss: () -> Unit) {
    val item = items.first()
    val excluded = items.map { it.id }.toSet()
    var folderId by rememberSaveable { mutableStateOf(state.rootId) }
    LaunchedEffect(folderId) { folderId?.let { if (!state.folders.containsKey(it)) model.refresh(it) } }
    val folders = folderId?.let { state.folders[it] }?.filter { it.isFolder && it.id !in excluded } ?: emptyList()
    val title = if (folderId == state.rootId) "HushOS" else state.folders.values.flatten().firstOrNull { it.id == folderId }?.name ?: "Folder"
    ModalBottomSheet(onDismissRequest = dismiss) {
        Text("Move to $title", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        ListItem(
            headlineContent = { Text(if (folderId == item.node.parentId) "Already here" else "Move here") },
            modifier = Modifier.clickable(enabled = folderId != null && folderId != item.node.parentId) { folderId?.let { model.moveAll(items, it) }; dismiss() },
        )
        HorizontalDivider()
        LazyColumn {
            items(folders, key = { it.id }) { folder ->
                ListItem(
                    headlineContent = { Text(folder.name) },
                    leadingContent = { Icon(Icons.Outlined.Folder, null, tint = MaterialTheme.colorScheme.primary) },
                    modifier = Modifier.clickable { folderId = folder.id },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VersionsSheet(model: DriveViewModel, item: Opened, dismiss: () -> Unit) {
    var versions by remember { mutableStateOf<List<VersionListView>?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(item.id) { versions = model.versions(item) }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Text("Versions", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        LazyColumn {
            items(versions ?: emptyList(), key = { it.id }) { version ->
                val created = runCatching { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(Instant.parse(version.createdAt).toEpochMilli())) }.getOrDefault(version.createdAt)
                ListItem(
                    headlineContent = { Text(created) },
                    supportingContent = { Text(if (version.current) "Current version" else if (version.status == "ready") "Earlier version" else version.status) },
                    trailingContent = {
                        if (!version.current && version.status == "ready") TextButton(onClick = { model.restoreVersion(version, item); dismiss() }) { Text("Restore") }
                    },
                    modifier = Modifier.fillMaxWidth().clickable(enabled = version.status == "ready") {
                        scope.launch { model.download(item, version)?.let { openWith(context, it, mimeOf(item)) } }
                    },
                )
            }
        }
    }
}

/* Which tags an item carries: toggle the existing ones, or make a new one and apply it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TagsSheet(model: DriveViewModel, state: DriveState, item: Opened, dismiss: () -> Unit) {
    var selected by remember { mutableStateOf<Set<String>?>(null) }
    var newName by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(item.id) { model.refreshTags() }
    LaunchedEffect(state.tags) { if (selected == null) selected = state.tags.tagsOf(item.id).map { it.id }.toSet() }
    val chosen = selected ?: emptySet()
    ModalBottomSheet(onDismissRequest = dismiss) {
        Text(item.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            OutlinedTextField(value = newName, onValueChange = { newName = it }, singleLine = true, label = { Text("New tag") }, modifier = Modifier.weight(1f))
            TextButton(enabled = newName.isNotBlank(), onClick = {
                val name = newName; newName = ""
                model.editTags { registry -> val tag = registry.add(name); selected = chosen + tag.id }
            }) { Text("Add") }
        }
        if (state.tags.tags.isEmpty()) Text("No tags yet. Tags group items across folders.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
        LazyColumn {
            items(state.tags.tags, key = { it.id }) { tag ->
                ListItem(
                    headlineContent = { TagPill(tag, selected = tag.id in chosen) },
                    trailingContent = { if (tag.id in chosen) Icon(androidx.compose.material.icons.Icons.Outlined.Check, null, tint = MaterialTheme.colorScheme.primary) },
                    modifier = Modifier.clickable { selected = if (tag.id in chosen) chosen - tag.id else chosen + tag.id },
                )
            }
        }
        androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.End) {
            TextButton(onClick = dismiss) { Text("Cancel") }
            TextButton(onClick = { val ids = chosen.toList(); model.editTags { it.assign(item.id, ids) }; dismiss() }) { Text("Save") }
        }
    }
}

/* Paper's tag colours: the presets, or the hex a person picked on the web. */
fun tagColour(value: String): androidx.compose.ui.graphics.Color = when (value) {
    "blue" -> androidx.compose.ui.graphics.Color(0xFF2C428E)
    "ink" -> androidx.compose.ui.graphics.Color(0xFF1C2848)
    "yellow" -> androidx.compose.ui.graphics.Color(0xFFC9A227)
    "teal" -> androidx.compose.ui.graphics.Color(0xFF2A7F7F)
    "coral" -> androidx.compose.ui.graphics.Color(0xFFD9634A)
    else -> value.removePrefix("#").toLongOrNull(16)?.let { androidx.compose.ui.graphics.Color(0xFF000000 or it) } ?: androidx.compose.ui.graphics.Color.Gray
}
