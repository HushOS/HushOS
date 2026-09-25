package com.hushos.app.ui

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
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Checklist
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
fun openWith(context: android.content.Context, uri: android.net.Uri, mime: String?) {
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { context.startActivity(Intent.createChooser(intent, null)) }
}

/* The tree: the root folder, each folder pushed on a simple stack, with the actions a cloud drive offers. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BrowseScreen(model: DriveViewModel, state: DriveState, start: Opened? = null, onLeave: (() -> Unit)? = null) {
    // With `start` the screen browses a shared folder: the same tools, in the granter's workspace.
    val stack = remember(start?.id) { mutableStateListOf<Opened>().apply { start?.let { add(it) } } }
    val current = stack.lastOrNull()
    val folderId = current?.id ?: state.rootId
    val floor = if (start != null) 1 else 0
    var fabOpen by rememberSaveable { mutableStateOf(false) }
    DisposableEffect(fabOpen) {
        model.addMenu(fabOpen)
        onDispose { if (fabOpen) model.addMenu(false) }
    }
    var newFolder by rememberSaveable { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Opened?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingUploads by remember { mutableStateOf<List<android.net.Uri>>(emptyList()) }
    var clashes by remember { mutableStateOf<List<String>>(emptyList()) }
    var renames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty() || folderId == null) return@rememberLauncherForActivityResult
        val names = uris.mapNotNull { uri -> model.displayName(uri) }
        val existing = (state.folders[folderId] ?: emptyList()).filter { !it.isFolder }.map { it.name.lowercase() }.toSet()
        val found = names.filter { it.lowercase() in existing }
        if (found.isEmpty()) model.upload(uris, folderId) else { pendingUploads = uris; clashes = found }
    }
    LaunchedEffect(Unit) { model.loadRoot(); model.refreshTags() }
    LaunchedEffect(folderId) { if (folderId != null && !state.folders.containsKey(folderId)) model.refresh(folderId) }
    BackHandler(enabled = stack.size > floor || onLeave != null) { if (stack.size > floor) stack.removeAt(stack.lastIndex) else onLeave?.invoke() }
    // Declared after the folder handler so it wins: Back closes the add menu before it leaves a folder or the app.
    BackHandler(enabled = fabOpen) { fabOpen = false }
    var query by rememberSaveable { mutableStateOf("") }
    var tagFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    var movingMany by rememberSaveable { mutableStateOf(false) }
    // Per folder: a bar hidden by scrolling one folder must not stay hidden in the next, where an empty
    // list cannot scroll to bring it (and its back arrow) back.
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior(androidx.compose.runtime.key(folderId) { rememberTopAppBarState() })
    // How this drive's lists are ordered, kept across launches; folders always come first.
    val prefs = LocalContext.current.getSharedPreferences("files", android.content.Context.MODE_PRIVATE)
    var sortKey by rememberSaveable { mutableStateOf(prefs.getString("sortKey", "name") ?: "name") }
    var sortAscending by rememberSaveable { mutableStateOf(prefs.getBoolean("sortAscending", true)) }
    var sortMenu by remember { mutableStateOf(false) }
    // A tag filter belongs to the folder it was set in; opening another folder starts unfiltered.
    var filteredIn by rememberSaveable { mutableStateOf(folderId) }
    LaunchedEffect(folderId) { if (filteredIn != folderId) { filteredIn = folderId; tagFilter = null } }
    val listState = androidx.compose.runtime.key(folderId) { rememberLazyListState() }
    // A new order starts at the top, once the list holds it; scrolling earlier would still follow the anchored row.
    var sortSeen by remember { mutableStateOf(sortKey to sortAscending) }
    LaunchedEffect(sortKey, sortAscending) {
        if (sortSeen != (sortKey to sortAscending)) { sortSeen = sortKey to sortAscending; listState.scrollToItem(0) }
    }
    val unfiltered = if (query.isBlank()) sortItems(folderId?.let { state.folders[it] } ?: emptyList(), sortKey, sortAscending)
        else state.everything.filter { it.name.contains(query.trim(), ignoreCase = true) }.sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    val items = tagFilter?.let { id -> unfiltered.filter { it.id in state.tags.nodesWith(id) } } ?: unfiltered
    Scaffold(
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            if (picked.isNotEmpty()) {
                // Everything picked at once: the contextual bar the drives show while selecting.
                val chosen = (folderId?.let { state.folders[it] } ?: emptyList()).filter { it.id in picked }
                TopAppBar(
                    title = { Text("${picked.size} selected") },
                    navigationIcon = { IconButton(onClick = { picked = emptySet() }) { Icon(Icons.Outlined.Close, "Done") } },
                    actions = {
                        IconButton(onClick = { model.copy(chosen); picked = emptySet() }) { Icon(Icons.Outlined.ContentCopy, "Copy") }
                        IconButton(onClick = { model.cut(chosen); picked = emptySet() }) { Icon(Icons.Outlined.ContentCut, "Cut") }
                        IconButton(onClick = { movingMany = true }) { Icon(Icons.Outlined.DriveFileMove, "Move") }
                        IconButton(onClick = { model.trashAll(chosen); picked = emptySet() }) { Icon(Icons.Outlined.Delete, "Trash") }
                    },
                )
            } else {
                TopAppBar(
                    title = { Text(current?.name ?: "Files") },
                    navigationIcon = { if (current != null) IconButton(onClick = { if (stack.size > floor) stack.removeAt(stack.lastIndex) else onLeave?.invoke() }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
                    actions = {
                        // One control for how the list is shown: its label is the order, its menu sorts and filters by a tag
                        // (only the tags this folder's items carry), and nothing on the page comes and goes.
                        Box {
                            val here = folderId?.let { state.folders[it] } ?: emptyList()
                            val folderTags = state.tags.tags.filter { tag -> here.any { it.id in state.tags.nodesWith(tag.id) } }
                            // The funnel says the menu filters as well as sorts; the words say the order in force.
                            TextButton(onClick = { sortMenu = true }, modifier = Modifier.semantics { contentDescription = "Sort and filter" }) {
                                Icon(Icons.Outlined.FilterList, null, modifier = Modifier.padding(end = 6.dp).size(18.dp),
                                    tint = if (tagFilter != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(sortLabel(sortKey))
                                Icon(if (sortAscending) Icons.Outlined.ArrowUpward else Icons.Outlined.ArrowDownward, null, modifier = Modifier.padding(start = 4.dp).size(16.dp))
                            }
                            DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                                Text("Sort by", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                                for (key in listOf("name", "modified", "size")) DropdownMenuItem(
                                    text = { Text(sortLabel(key)) },
                                    trailingIcon = { if (key == sortKey) Icon(if (sortAscending) Icons.Outlined.ArrowUpward else Icons.Outlined.ArrowDownward, null, modifier = Modifier.size(16.dp)) },
                                    onClick = {
                                        if (key == sortKey) sortAscending = !sortAscending else { sortKey = key; sortAscending = key == "name" }
                                        prefs.edit().putString("sortKey", sortKey).putBoolean("sortAscending", sortAscending).apply()
                                        sortMenu = false
                                    },
                                )
                                androidx.compose.material3.HorizontalDivider(Modifier.padding(vertical = 4.dp))
                                Text("Tag", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                                if (folderTags.isEmpty()) DropdownMenuItem(text = { Text("No tags in this folder") }, enabled = false, onClick = {})
                                for (tag in folderTags) DropdownMenuItem(
                                    text = { TagPill(tag, selected = tag.id == tagFilter) },
                                    trailingIcon = { if (tag.id == tagFilter) Icon(Icons.Outlined.Check, null, modifier = Modifier.size(16.dp)) },
                                    onClick = { tagFilter = if (tagFilter == tag.id) null else tag.id; sortMenu = false },
                                )
                            }
                        }
                    },
                    scrollBehavior = scroll,
                    // Scrolling (or pulling to refresh) must not tint the bar: the sheet stays one colour.
                    colors = TopAppBarDefaults.topAppBarColors(scrolledContainerColor = MaterialTheme.colorScheme.surface),
                )
            }
        },
        floatingActionButton = {
            // The menu pads its button a second time; pull it back to the usual 16dp from the edges.
            FloatingActionButtonMenu(
                modifier = Modifier.offset(x = 16.dp, y = 16.dp),
                expanded = fabOpen,
                button = {
                    ToggleFloatingActionButton(checked = fabOpen, onCheckedChange = { fabOpen = it }) {
                        val icon = if (checkedProgress > 0.5f) Icons.Outlined.Close else Icons.Outlined.Add
                        Icon(icon, contentDescription = "Add", modifier = Modifier.animateIcon({ checkedProgress }))
                    }
                },
            ) {
                state.clipboard?.takeIf { folderId != null && model.canPaste(folderId) }?.let { (items, cut) ->
                    FloatingActionButtonMenuItem(onClick = { fabOpen = false; folderId?.let { model.paste(it) } }, icon = { Icon(if (cut) Icons.Outlined.ContentCut else Icons.Outlined.ContentPaste, null) }, text = { Text(if (items.size > 1) "Paste ${items.size} items" else "Paste ${items.first().name}") })
                }
                FloatingActionButtonMenuItem(onClick = { fabOpen = false; newFolder = "" }, icon = { Icon(Icons.Outlined.CreateNewFolder, null) }, text = { Text("New folder") })
                if (items.isNotEmpty()) FloatingActionButtonMenuItem(onClick = { fabOpen = false; picked = setOf(items.first().id) }, icon = { Icon(Icons.Outlined.Checklist, null) }, text = { Text("Select items") })
                FloatingActionButtonMenuItem(onClick = { fabOpen = false; picker.launch(arrayOf("*/*")) }, icon = { Icon(Icons.Outlined.UploadFile, null) }, text = { Text("Upload files") })
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
        TextField(
            value = query, onValueChange = { query = it }, singleLine = true,
            placeholder = { Text(if (current == null) "Search in HushOS" else "Search in ${current.name}") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear") } },
            shape = CircleShape,
            colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 0.dp, bottom = 12.dp),
        )
        if (folderId != null && folderId in state.loading && !state.folders.containsKey(folderId)) {
            androidx.compose.material3.LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp))
        }
        state.tags.tags.firstOrNull { it.id == tagFilter }?.let { tag ->
            // The filter says so where the rows are, so a shorter list never looks like missing files.
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Filtered by", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
                TagPill(tag, selected = true)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { tagFilter = null }) { Text("Clear") }
            }
        }
        state.clipboard?.let { (clip, cut) ->
            // Something on the clipboard: say so where it can be pasted, not only inside the add menu.
            androidx.compose.material3.Surface(tonalElevation = 3.dp, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (cut) Icons.Outlined.ContentCut else Icons.Outlined.ContentPaste, null, modifier = Modifier.padding(end = 8.dp))
                    Text(if (clip.size > 1) "${clip.size} items ready to ${if (cut) "move" else "copy"}" else "${clip.first().name} ready to ${if (cut) "move" else "copy"}", modifier = Modifier.weight(1f), maxLines = 1)
                    TextButton(enabled = folderId != null && model.canPaste(folderId), onClick = { folderId?.let { model.paste(it) } }) { Text(folderId?.let { model.pasteProblem(it) } ?: "Paste here") }
                    IconButton(onClick = { model.clearClipboard() }) { Icon(Icons.Outlined.Close, "Cancel") }
                }
            }
        }
        // The spinner follows the refresh, not every write: an upload waiting out a dead network must not look like a stuck pull.
        PullToRefreshBox(isRefreshing = folderId != null && folderId in state.loading, onRefresh = { folderId?.let { model.refresh(it) } }) {
            if (query.isBlank() && folderId != null && state.folders.containsKey(folderId) && items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    // A filter that hides everything says so, rather than calling a full folder empty.
                    val filteredBy = state.tags.tags.firstOrNull { it.id == tagFilter }?.name
                    Text(if (filteredBy != null && unfiltered.isNotEmpty()) "Nothing tagged $filteredBy in this folder." else "Nothing here yet. Add files with the button, or from the Files app.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(32.dp))
                }
            } else if (query.isBlank() && (folderId == null || !state.folders.containsKey(folderId)) && state.unreachable && folderId !in state.loading) {
                // Nothing on this phone for this folder and no network to fetch it: say so instead of a blank sheet.
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("This folder has not been opened on this phone yet. It will load when you are back online.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(32.dp))
                }
            }
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                items(items, key = { it.id }) { item ->
                    // No checkbox column: while selecting, a tap toggles and a picked row shows its tint and check.
                    NodeRow(model, state, item,
                        onClick = {
                            if (picked.isNotEmpty()) picked = if (item.id in picked) picked - item.id else picked + item.id
                            else if (item.isFolder) { query = ""; stack.add(item) }
                            else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item)) } }
                        },
                        onLongClick = { if (picked.isEmpty()) selected = item else picked = if (item.id in picked) picked - item.id else picked + item.id },
                        selected = item.id in picked)
                }
            }
        }
        }
    }
    if (clashes.isNotEmpty() && folderId != null) {
        AlertDialog(
            onDismissRequest = { clashes = emptyList(); pendingUploads = emptyList() },
            title = { Text(if (clashes.size == 1) "“${clashes[0]}” already exists here" else "${clashes.size} of these already exist here") },
            text = {
                Column {
                    Text("Replacing keeps the earlier version under Versions.")
                    TextButton(onClick = { model.upload(pendingUploads, folderId, DriveViewModel.Conflict.REPLACE); clashes = emptyList() }) { Text("Replace (keep as new version)") }
                    TextButton(onClick = { renames = clashes.associateWith { model.freeName(it, (state.folders[folderId] ?: emptyList()).map { f -> f.name.lowercase() }.toSet()) }; clashes = emptyList() }) { Text("Keep both…") }
                    TextButton(onClick = { model.upload(pendingUploads, folderId, DriveViewModel.Conflict.SKIP); clashes = emptyList() }) { Text("Skip those") }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { clashes = emptyList(); pendingUploads = emptyList() }) { Text("Cancel") } },
        )
    }
    if (renames.isNotEmpty() && folderId != null) {
        val taken = (state.folders[folderId] ?: emptyList()).map { it.name.lowercase() }.toSet()
        val valid = renames.values.all { it.isNotBlank() && it.trim().lowercase() !in taken }
        AlertDialog(
            onDismissRequest = { renames = emptyMap(); pendingUploads = emptyList() },
            title = { Text("Keep both") },
            text = {
                Column {
                    for ((original, name) in renames) OutlinedTextField(value = name, onValueChange = { renames = renames + (original to it) }, singleLine = true, label = { Text(original) }, modifier = Modifier.padding(top = 8.dp))
                }
            },
            confirmButton = { TextButton(enabled = valid, onClick = { model.upload(pendingUploads, folderId, DriveViewModel.Conflict.KEEP_BOTH, renames.mapValues { it.value.trim() }); renames = emptyMap() }) { Text("Upload") } },
            dismissButton = { TextButton(onClick = { renames = emptyMap(); pendingUploads = emptyList() }) { Text("Cancel") } },
        )
    }
    newFolder?.let { draft ->
        AlertDialog(
            onDismissRequest = { newFolder = null },
            title = { Text("New folder") },
            text = { OutlinedTextField(value = draft, onValueChange = { newFolder = it }, singleLine = true, label = { Text("Name") }) },
            confirmButton = { TextButton(enabled = draft.isNotBlank(), onClick = { folderId?.let { model.createFolder(draft.trim(), it) }; newFolder = null }) { Text("Create") } },
            dismissButton = { TextButton(onClick = { newFolder = null }) { Text("Cancel") } },
        )
    }
    selected?.let { item -> ItemActions(model, state, item, onSelect = { picked = picked + item.id }) { selected = null } }
}

private enum class HomeFilter(val label: String) { ALL("All"), FOLDERS("Folders"), IMAGES("Images"), VIDEOS("Videos"), DOCUMENTS("Documents") }

private fun HomeFilter.matches(item: Opened): Boolean {
    val mime = mimeOf(item) ?: ""
    return when (this) {
        HomeFilter.ALL -> true
        HomeFilter.FOLDERS -> item.isFolder
        HomeFilter.IMAGES -> mime.startsWith("image/")
        HomeFilter.VIDEOS -> mime.startsWith("video/")
        HomeFilter.DOCUMENTS -> !item.isFolder && (mime == "application/pdf" || mime.startsWith("text/") || mime.contains("document") || mime.contains("presentation") || mime.contains("sheet"))
    }
}

/*
 * Home: the search pill first, then type chips, then what changed most
 * recently across every folder. The layout of a cloud drive, not of Files.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(model: DriveViewModel, state: DriveState) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(HomeFilter.ALL) }
    var tagFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var tagged by remember { mutableStateOf<List<Opened>>(emptyList()) }
    var managingTags by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Opened?>(null) }
    var forgetting by remember { mutableStateOf<com.hushos.app.data.Offline.Entry?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { model.refreshRecents(); model.refreshTags(); model.refreshOffline() }
    val base = when {
        tagFilter != null -> tagged.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
        query.isBlank() -> state.recents
        else -> state.everything.filter { it.name.contains(query.trim(), ignoreCase = true) }
            .sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }
    val rows = base.filter { filter.matches(it) }
    val heading = tagFilter?.let { id -> state.tags.tags.firstOrNull { it.id == id }?.name } ?: if (query.isBlank()) "Recent" else "Results"
    Column(Modifier.fillMaxSize()) {
        // Titled like the other tabs; the search pill sits under it rather than in its place.
        TopAppBar(title = { Text("Home") })
        TextField(
            value = query, onValueChange = { query = it }, singleLine = true,
            placeholder = { Text("Search in HushOS") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear") } },
            shape = CircleShape,
            colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 0.dp, bottom = 12.dp),
        )
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in HomeFilter.entries) FilterChip(selected = filter == option, onClick = { filter = option }, label = { Text(option.label) })
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Tags", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 8.dp))
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (tag in state.tags.tags) TagPill(tag, selected = tagFilter == tag.id) {
                    tagFilter = if (tagFilter == tag.id) null else tag.id
                    scope.launch { tagged = if (tagFilter == null) emptyList() else model.tagged(tag.id) }
                }
                if (state.tags.tags.isEmpty()) Text("None yet", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            androidx.compose.material3.TextButton(onClick = { managingTags = true }) { Text("Manage") }
        }
        PullToRefreshBox(isRefreshing = "recents" in state.loading, onRefresh = { model.refreshRecents() }) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (query.isBlank() && tagFilter == null && state.offline.isNotEmpty()) {
                    // Kept files first, the way Dropbox lists Offline on Home: they open without the network.
                    item(key = "offline-heading") { Text("Offline", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                    items(state.offline, key = { "offline-" + it.id }) { entry ->
                        androidx.compose.material3.ListItem(
                            headlineContent = { Text(entry.name) },
                            supportingContent = { Text(entry.size?.let { formatBytes(it) } ?: "Kept downloaded") },
                            leadingContent = { Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.DownloadForOffline, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(32.dp)) } },
                            // The same menu as any other row: a kept file is still a file (share, rename, remove the download).
                            modifier = Modifier.combinedClickable(
                                onClick = {
                                    val file = com.hushos.app.data.Offline.file(context, entry)
                                    if (file.exists()) openWith(context, androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file), entry.mime)
                                },
                                onLongClick = { model.item(entry.id)?.let { selected = it } ?: run { forgetting = entry } },
                            ),
                        )
                    }
                }
                item { Text(heading, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                if ("recents" in state.loading && rows.isEmpty()) item(key = "loading") { androidx.compose.material3.LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) }
                // The empty word sits in the list under its heading, never over the rows above it.
                if (rows.isEmpty() && "recents" !in state.loading) item(key = "empty") {
                    Text(if (query.isBlank()) "Files you add or change show up here." else "No results for \"$query\"", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp))
                }
                items(rows, key = { it.id }) { item ->
                    NodeRow(model, state, item,
                        onClick = { if (!item.isFolder) scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item)) } } },
                        onLongClick = { selected = item })
                }
            }
        }
    }
    selected?.let { item -> ItemActions(model, state, item) { selected = null } }
    // A kept file this device cannot name in the tree (not opened yet): the one thing it can still do.
    forgetting?.let { entry ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text(entry.name) },
            text = { Text("Remove the downloaded copy from this phone? The file stays in HushOS.") },
            confirmButton = { TextButton(onClick = { model.forgetOffline(entry.id); forgetting = null }) { Text("Remove download") } },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
        )
    }
    if (managingTags) TagManagerSheet(model, state) { managingTags = false }
}

/* Every tag in the workspace: rename, recolour, delete, and how many items each names. */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun TagManagerSheet(model: DriveViewModel, state: DriveState, dismiss: () -> Unit) {
    var newName by rememberSaveable { mutableStateOf("") }
    var renaming by remember { mutableStateOf<com.hushos.app.data.Tag?>(null) }
    var renameDraft by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { model.refreshTags() }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = dismiss) {
        Text("Tags", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = newName, onValueChange = { newName = it }, singleLine = true, label = { Text("New tag") }, modifier = Modifier.weight(1f))
            TextButton(enabled = newName.isNotBlank(), onClick = { val name = newName; newName = ""; model.editTags { it.add(name) } }) { Text("Add") }
        }
        if (state.tags.tags.isEmpty()) Text("No tags yet. Tags group items across folders.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
        LazyColumn {
            items(state.tags.tags, key = { it.id }) { tag ->
                var colours by remember { mutableStateOf(false) }
                androidx.compose.material3.ListItem(
                    headlineContent = { TagPill(tag) },
                    supportingContent = { Text("${state.tags.nodesWith(tag.id).size} items") },
                    leadingContent = {
                        Box(Modifier.size(22.dp).background(tagColour(tag.colour), CircleShape).clickable { colours = true })
                        if (colours) ColourDialog(current = tag.colour, onPick = { colour -> colours = false; model.editTags { it.recolour(tag.id, colour) } }, onDismiss = { colours = false })
                    },
                    trailingContent = {
                        Row {
                            IconButton(onClick = { renameDraft = tag.name; renaming = tag }) { Icon(androidx.compose.material.icons.Icons.Outlined.Edit, "Rename") }
                            IconButton(onClick = { model.editTags { it.remove(tag.id) } }) { Icon(androidx.compose.material.icons.Icons.Outlined.Delete, "Delete") }
                        }
                    },
                )
            }
            item {
                Text("Tags live in a sealed workspace document, so people you share with never see them.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
            }
        }
    }
    renaming?.let { tag ->
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename tag") },
            text = { OutlinedTextField(value = renameDraft, onValueChange = { renameDraft = it }, singleLine = true) },
            confirmButton = { TextButton(enabled = renameDraft.isNotBlank(), onClick = { val name = renameDraft; renaming = null; model.editTags { it.rename(tag.id, name) } }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }
}

/* The presets, a palette, or any hex colour typed in, as the web offers. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ColourDialog(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var hex by rememberSaveable { mutableStateOf(if (current.startsWith("#")) current else "") }
    val palette = com.hushos.app.data.TagRegistry.PRESETS + listOf("#d92d20", "#f79009", "#12b76a", "#0ba5ec", "#6172f3", "#9e77ed", "#dd2590", "#7a5c3a", "#475467", "#101828")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Tag colour") },
        text = {
            Column {
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (colour in palette) Box(
                        Modifier.size(34.dp).background(tagColour(colour), CircleShape)
                            .then(if (colour == current) Modifier.border(3.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier)
                            .clickable { onPick(colour) },
                    )
                }
                OutlinedTextField(value = hex, onValueChange = { hex = it.lowercase() }, singleLine = true, label = { Text("Any colour, as #rrggbb") }, modifier = Modifier.padding(top = 16.dp).fillMaxWidth())
            }
        },
        confirmButton = { TextButton(enabled = Regex("^#[0-9a-f]{6}$").matches(hex), onClick = { onPick(hex) }) { Text("Use colour") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/* Shared: what other people gave this account, each opened with the identity keys and browsable like a folder. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SharedScreen(model: DriveViewModel, state: DriveState) {
    val stack = remember { mutableStateListOf<Opened>() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<Opened?>(null) }
    var linkText by remember { mutableStateOf("") }
    var openLink by remember { mutableStateOf<String?>(null) }
    var reporting by remember { mutableStateOf<Opened?>(null) }
    var showingContacts by remember { mutableStateOf(false) }
    var byMe by rememberSaveable { mutableStateOf(false) }
    var mine by remember { mutableStateOf<List<SharedByMe>?>(null) }
    var managing by remember { mutableStateOf<Opened?>(null) }
    LaunchedEffect(byMe, managing) { if (byMe && managing == null) mine = model.sharedByMe() }
    openLink?.let { url ->
        LinkBrowser(state.origin, url) { openLink = null }
        return
    }
    stack.firstOrNull()?.let { root ->
        // A shared folder gets the full browse screen: search, select, paste, add, all in the granter's workspace.
        BrowseScreen(model, state, start = root) { stack.clear() }
        return
    }
    LaunchedEffect(Unit) { model.refreshShares() }
    val current = stack.lastOrNull()
    LaunchedEffect(current?.id) { current?.let { if (!state.folders.containsKey(it.id)) model.refresh(it.id) } }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }
    Scaffold(contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0), topBar = {
        TopAppBar(title = { Text(current?.name ?: "Shared") },
            navigationIcon = { if (current != null) IconButton(onClick = { stack.removeAt(stack.lastIndex) }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            actions = { if (current == null) IconButton(onClick = { showingContacts = true }) { Icon(Icons.Outlined.Contacts, "Contacts") } })
    }) { padding ->
        if (current != null) {
            val items = state.folders[current.id] ?: emptyList()
            LazyColumn(Modifier.padding(padding).fillMaxSize()) {
                items(items, key = { it.id }) { item ->
                    NodeRow(model, state, item,
                        onClick = { if (item.isFolder) stack.add(item) else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item)) } } },
                        onLongClick = { selected = item })
                }
            }
        } else {
            PullToRefreshBox(isRefreshing = state.busy, onRefresh = { model.refreshShares() }, modifier = Modifier.padding(padding)) {
                val shares = state.shares
                if (shares != null && shares.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Folders and files others share with you appear here.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(32.dp))
                }
                LazyColumn(Modifier.fillMaxSize()) {
                    item(key = "which") {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                            SegmentedButton(selected = !byMe, onClick = { byMe = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("With me") }
                            SegmentedButton(selected = byMe, onClick = { byMe = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("By me") }
                        }
                    }
                    if (byMe) {
                        val rows = mine
                        if (rows != null && rows.isEmpty()) item { Text("You have not shared anything yet. Long-press an item and choose Share.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp)) }
                        items(rows.orEmpty(), key = { it.id }) { row ->
                            val detail = row.share?.let { "With " + it.granteeName.ifEmpty { it.granteeEmail } + " · " + (if (it.role == "editor") "can edit" else "can view") }
                                ?: row.link?.let { "Link · " + (if (it.useCount == 1) "opened once" else "opened ${it.useCount} times") + (if (it.hasPassword) " · password" else "") } ?: ""
                            androidx.compose.material3.ListItem(
                                headlineContent = { Text(row.item?.name ?: "Item outside this workspace") },
                                supportingContent = { Text(detail) },
                                leadingContent = { Icon(if (row.link != null) Icons.Outlined.Link else Icons.Outlined.Person, null, tint = MaterialTheme.colorScheme.primary) },
                                modifier = Modifier.clickable(enabled = row.item != null) { managing = row.item },
                            )
                        }
                        return@LazyColumn
                    }
                    item(key = "open-link") {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                            OutlinedTextField(value = linkText, onValueChange = { linkText = it }, singleLine = true, label = { Text("Paste a HushOS link") }, modifier = Modifier.weight(1f))
                            TextButton(enabled = linkText.contains("/s/"), onClick = { openLink = linkText.trim() }, modifier = Modifier.padding(start = 8.dp)) { Text("Open") }
                        }
                    }
                    items(shares.orEmpty(), key = { it.share.id }) { mount ->
                        val granter = mount.share.granterName.ifEmpty { mount.share.granterEmail }
                        androidx.compose.material3.ListItem(
                            headlineContent = { Text(mount.root?.name ?: "Shared folder") },
                            supportingContent = { Text(mount.error ?: "From $granter · " + mount.share.role.replaceFirstChar { it.uppercase() }) },
                            leadingContent = { Icon(if (mount.share.isFolder) Icons.Outlined.Folder else Icons.Outlined.UploadFile, null, tint = MaterialTheme.colorScheme.primary) },
                            trailingContent = { if (mount.root != null) IconButton(onClick = { reporting = mount.root }) { Icon(Icons.Outlined.Flag, "Report") } },
                            modifier = Modifier.clickable(enabled = mount.root != null) {
                                mount.root?.let { root -> if (root.isFolder) stack.add(root) else scope.launch { model.download(root)?.let { openWith(context, it, mimeOf(root)) } } }
                            },
                        )
                    }
                }
            }
        }
    }
    selected?.let { item -> ItemActions(model, state, item) { selected = null } }
    reporting?.let { item -> ReportDialog(item, dismiss = { reporting = null }) { category, reason, email -> model.report(item, category, reason, email) } }
    if (showingContacts) ContactsSheet(model) { showingContacts = false }
    managing?.let { item -> LinkSheet(model, item) { managing = null } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(model: DriveViewModel, state: DriveState, onBack: (() -> Unit)? = null) {
    var confirmEmpty by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf<com.hushos.app.data.TrashItem?>(null) }
    LaunchedEffect(Unit) { model.refreshTrash() }
    Scaffold(contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0), topBar = {
        TopAppBar(title = { Text("Trash") }, navigationIcon = { onBack?.let { IconButton(onClick = it) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } } }, actions = { TextButton(enabled = state.trash.isNotEmpty(), onClick = { confirmEmpty = true }) { Text("Empty") } })
    }) { padding ->
        PullToRefreshBox(isRefreshing = state.busy, onRefresh = { model.refreshTrash() }, modifier = Modifier.padding(padding)) {
            if (state.trash.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Items you delete stay here until you remove them.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.trash, key = { it.item.id }) { entry ->
                    val trashed = entry.item.node.trashedAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
                        ?.let { "Trashed " + java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(it)) }
                    NodeRow(model, state, entry.item, onClick = { selected = entry }, onLongClick = { selected = entry }, note = trashed)
                }
            }
        }
    }
    selected?.let { entry ->
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text(entry.item.name) },
            text = { Text(if (entry.parentTrashed) "Its folder is in the trash too; restoring puts it at the top level." else "Restore it, or delete it forever.") },
            confirmButton = { TextButton(onClick = { model.restore(entry); selected = null }) { Text("Restore") } },
            dismissButton = { TextButton(onClick = { model.purge(entry); selected = null }) { Text("Delete forever", color = MaterialTheme.colorScheme.error) } },
        )
    }
    if (confirmEmpty) {
        AlertDialog(
            onDismissRequest = { confirmEmpty = false },
            title = { Text("Empty the trash?") },
            text = { Text("${state.trash.size} items will be deleted forever. This cannot be undone.") },
            confirmButton = { TextButton(onClick = { model.emptyTrash(); confirmEmpty = false }) { Text("Empty", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmEmpty = false }) { Text("Cancel") } },
        )
    }
}

fun sortLabel(key: String) = when (key) { "modified" -> "Modified"; "size" -> "Size"; else -> "Name" }

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
