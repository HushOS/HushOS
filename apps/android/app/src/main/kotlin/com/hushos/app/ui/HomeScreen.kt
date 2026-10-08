package com.hushos.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Offline
import com.hushos.app.data.Opened
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch

enum class TypeFilter(val label: String, val plural: String) {
    ALL("All", "files"), FOLDERS("Folders", "folders"), IMAGES("Images", "images"), VIDEOS("Videos", "videos"), DOCUMENTS("Documents", "documents");

    fun matches(item: Opened): Boolean {
        val mime = mimeOf(item) ?: ""
        return when (this) {
            ALL -> true
            FOLDERS -> item.isFolder
            IMAGES -> mime.startsWith("image/")
            VIDEOS -> mime.startsWith("video/")
            DOCUMENTS -> !item.isFolder && (mime == "application/pdf" || mime.startsWith("text/") || mime.contains("document") || mime.contains("presentation") || mime.contains("sheet"))
        }
    }
}

/* The type chips, Home's and search's: All, Folders, Images, Videos, Documents. */
@Composable
private fun TypeChips(value: TypeFilter, onChange: (TypeFilter) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        for (option in TypeFilter.entries) AlpineChip(option.label, selected = value == option, onClick = { onChange(option) })
    }
}

/*
 * Home: the header, the search bar under it; then what is on this phone, and
 * Recent with its own filters under its title: the type chips, then the tags
 * (once there is one). The + adds into Files, as Files' own does.
 * `screen` is which page of Home is showing: "home", "search", "phone", or
 * "folder:<id>" for a folder opened from Recent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(model: DriveViewModel, state: DriveState, screen: String, go: (String) -> Unit) {
    when {
        screen == "search" -> { SearchScreen(model, state) { go("home") }; return }
        screen == "phone" -> { OnThisPhoneScreen(model, state) { go("home") }; return }
        screen.startsWith("folder:") -> {
            RestoredFolder(model, screen.removePrefix("folder:"), onGone = { go("home") }) { folder -> BrowseScreen(model, state, start = folder, onLeave = { go("home") }) }
            return
        }
    }
    val alpine = Alpine.colors
    var filter by rememberSaveable { mutableStateOf(TypeFilter.ALL) }
    var tagFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var tagged by remember { mutableStateOf<List<Opened>>(emptyList()) }
    var managingTags by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSavedItem(model)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Adding from Home goes into Files, with Files' menu, questions and dialogs.
    val add = addInto(model, state, state.rootId, "Files")
    var fabOpen by rememberSaveable { mutableStateOf(false) }
    DisposableEffect(fabOpen) {
        model.addMenu(fabOpen)
        onDispose { if (fabOpen) model.addMenu(false) }
    }
    BackHandler(enabled = fabOpen) { fabOpen = false }
    // New folder and the same-name questions look at what is in Files: fetched once the menu opens, if not yet.
    val rootMissing = needsLoad(state.rootId, state.folders, state.loading, state.failedFolders)
    LaunchedEffect(fabOpen, rootMissing) { if (fabOpen && rootMissing) state.rootId?.let { model.refresh(it) } }
    val clip = state.clipboard
    val paste = clip?.first?.let { items ->
        state.rootId?.takeIf { model.pasteProblem(it) == null }?.let { root -> (if (items.size == 1) "Paste “${items[0].name}”" else "Paste ${items.size} items") to { model.paste(root); Unit } }
    }
    LaunchedEffect(Unit) { model.refreshRecents(); model.refreshTags(); model.refreshOffline(); model.refreshAccess() }
    // Back online after an offline start: who can open each row comes back without a relaunch.
    LaunchedEffect(state.unreachable) { if (!state.unreachable) model.refreshAccess() }
    // A tag that went away (deleted here or elsewhere) stops filtering.
    LaunchedEffect(state.tags) { if (tagFilter != null && state.tags.tags.none { it.id == tagFilter }) tagFilter = null }
    val base = if (tagFilter != null) tagged else state.recents
    val rows = base.filter { filter.matches(it) }
    val kept = state.offline.map { it.id }.toSet()
    val loading = "recents" in state.loading
    // A brand-new account: nothing anywhere yet, so Home offers the two ways to start instead of an empty Recent.
    val firstRun = !loading && state.recents.isEmpty() && model.searchesEverything() && model.searchable().isEmpty()
    val heading = state.tags.tags.firstOrNull { it.id == tagFilter }?.name ?: if (filter == TypeFilter.ALL) "Recent" else "Recent ${filter.plural}"
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        containerColor = alpine.ground,
        floatingActionButton = { if (state.rootId != null) AddButton(fabOpen, { fabOpen = it }, add, paste) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            DestinationBar("Home")
            Box(Modifier.padding(bottom = AlpineSpace.S2)) {
                SearchPill("Search your files", onClick = { go("search") })
            }
            // Above the list, not in it: an item added over the first row would land out of view.
            if (state.unreachable) OfflineCapsule()
            PullToRefreshBox(isRefreshing = loading && state.recents.isNotEmpty(), onRefresh = { model.refreshRecents(pulled = true); model.refreshAccess() }, modifier = Modifier.weight(1f)) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 88.dp)) {
                    if (firstRun) {
                        item(key = "first") {
                            EmptyState("Nothing here yet", "Files you add or change show up here.", Icons.Outlined.UploadFile, modifier = Modifier.padding(top = 40.dp)) {
                                Button(onClick = add.pickFiles, modifier = Modifier.fillMaxWidth()) {
                                    Icon(Icons.Outlined.UploadFile, null, modifier = Modifier.padding(end = AlpineSpace.S2)); Text("Upload files")
                                }
                                OutlinedButton(onClick = add.pickPhotos, modifier = Modifier.fillMaxWidth()) {
                                    Icon(Icons.Outlined.PhotoLibrary, null, modifier = Modifier.padding(end = AlpineSpace.S2)); Text("Upload photos")
                                }
                            }
                        }
                        return@LazyColumn
                    }
                    item(key = "phone") { OnThisPhoneRow(state) { go("phone") } }
                    // Recent is the page's section, at the Title size; its filters (types, then tags) sit under it.
                    item(key = "heading") {
                        Text(heading, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = alpine.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().semantics { heading() }.padding(start = AlpineSpace.S4, end = AlpineSpace.S4, top = AlpineSpace.S3))
                    }
                    item(key = "types") { TypeChips(filter) { filter = it } }
                    // The tags row stays away until there is a tag to show.
                    if (state.tags.tags.isNotEmpty()) item(key = "tags") {
                        // One row that scrolls to the screen's edges, label and Manage included, as the board draws it.
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S4),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2),
                        ) {
                            Text("Tags", style = MaterialTheme.typography.labelLarge, color = alpine.inkMuted, modifier = Modifier.padding(end = AlpineSpace.S1))
                            for (tag in state.tags.tags) AlpineChip(tag.name, selected = tagFilter == tag.id, leading = { TagDot(tag.colour) }, onClick = {
                                tagFilter = if (tagFilter == tag.id) null else tag.id
                                scope.launch { tagged = tagFilter?.let { model.tagged(it) } ?: emptyList() }
                            })
                            TextButton(onClick = { managingTags = true }) { Text("Manage") }
                        }
                    }
                    if (loading && rows.isEmpty()) item(key = "loading") { SkeletonRows(4) }
                    // The empty word sits in the list under its heading, never over the rows above it.
                    if (rows.isEmpty() && !loading) item(key = "empty") {
                        val name = state.tags.tags.firstOrNull { it.id == tagFilter }?.name
                        if (name != null) EmptyState(if (filter == TypeFilter.ALL) "Nothing tagged $name" else "No ${filter.plural} tagged $name", modifier = Modifier.padding(top = AlpineSpace.S6))
                        else EmptyState(if (filter == TypeFilter.ALL) "No recent files yet" else "No ${filter.plural} yet",
                            "${if (filter == TypeFilter.ALL) "Files" else filter.label} you add or change show up here.", modifier = Modifier.padding(top = AlpineSpace.S6))
                    }
                    items(rows, key = { it.id }) { item ->
                        // Offline, a file that isn't on this phone can't open: it dims and says so.
                        val away = state.unreachable && !item.isFolder && item.id !in kept
                        NodeRow(model, state, item, away = away, recent = true,
                            onClick = { if (item.isFolder) go("folder:${item.id}") else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item), model, item.name) } } },
                            onLongClick = { selected = item }, onMore = { selected = item })
                    }
                }
            }
        }
    }
    selected?.let { item -> ItemActions(model, state, item) { selected = null; model.refreshAccess() } }
    if (managingTags) TagManagerSheet(model, state) { managingTags = false }
}

/* The way into the files kept on this phone: always there, with how many and how much room. */
@Composable
private fun OnThisPhoneRow(state: DriveState, onClick: () -> Unit) {
    val alpine = Alpine.colors
    val entries = state.offline
    val folders = state.keptFolders.size
    val detail = if (entries.isEmpty() && folders == 0) "Files you keep here open without a connection" else {
        val count = if (entries.size == 1) "1 file" else "${entries.size} files"
        val sizes = entries.mapNotNull { it.size }
        // The size is left out when an entry never recorded one, rather than understated.
        listOfNotNull(if (folders == 0) null else if (folders == 1) "1 folder" else "$folders folders", count,
            if (sizes.size == entries.size) formatBytes(sizes.sum()) else null, "open without a connection").joinToString(" · ")
    }
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(48.dp).background(alpine.tint, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Smartphone, null, tint = alpine.onTint) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
            Text("On this phone", style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 2)
        }
    }
}

/*
 * Search, opened from the bar: back, the field, the type chips, then recent
 * searches until you type. Results say where each thing is. It looks through
 * the whole drive once the catalogue is built, and says less when it is not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(model: DriveViewModel, state: DriveState, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(TypeFilter.ALL) }
    var selected by rememberSavedItem(model)
    var folder by remember { mutableStateOf<Opened?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    BackHandler(onBack = onBack)
    folder?.let { open ->
        BrowseScreen(model, state, start = open, onLeave = { folder = null })
        return
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val hits = if (words.isEmpty()) emptyList() else model.searchable().filter { item ->
        if (!filter.matches(item)) return@filter false
        // Names, tags and the kind of file ("PDF document", "PNG image") are what search looks at.
        val text = (listOf(item.name, kindOf(item)) + state.tags.tagsOf(item.id).map { it.name }).joinToString(" ").lowercase()
        words.all { text.contains(it) }
    }.sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }).take(200)
    Column(Modifier.fillMaxSize().background(alpine.surface).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(72.dp).padding(horizontal = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
            TextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                placeholder = { Text("Search your files") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { model.rememberSearch(query) }),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    unfocusedPlaceholderColor = alpine.inkMuted, focusedPlaceholderColor = alpine.inkMuted,
                ),
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
            if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear search") }
        }
        HorizontalDivider(color = alpine.divider)
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "types") { TypeChips(filter) { filter = it } }
            if (words.isEmpty()) items(state.recentSearches, key = { "recent:$it" }) { term ->
                Row(Modifier.fillMaxWidth().height(56.dp).clickable { query = term }.padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.History, null, tint = alpine.inkMuted)
                    Text(term, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = AlpineSpace.S4))
                }
            }
            if (words.isNotEmpty() && hits.isEmpty()) item(key = "none") {
                EmptyState(
                    "No results for “${query.trim()}”",
                    if (model.searchesEverything()) "Search looks at names, tags and file types in every folder. Check the spelling, or try fewer words."
                    else "Search looks in folders you’ve opened on this phone. Check the spelling, or try fewer words.",
                    Icons.Outlined.Search, modifier = Modifier.padding(top = 64.dp),
                ) { if (filter != TypeFilter.ALL) TextButton(onClick = { filter = TypeFilter.ALL }) { Text("Search all types") } }
            }
            items(hits, key = { it.id }) { item ->
                val where = item.node.parentId?.let { if (it == state.rootId) "Files" else model.item(it)?.name } ?: "Files"
                NodeRow(model, state, item, note = "In $where",
                    onClick = {
                        model.rememberSearch(query)
                        if (item.isFolder) folder = item else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item), model, item.name) } }
                    },
                    onLongClick = { selected = item }, onMore = { selected = item })
            }
        }
    }
    selected?.let { item -> ItemActions(model, state, item) { selected = null } }
}

/* The files kept on this phone, newest first: they open without a connection. Long-press asks before removing one. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun OnThisPhoneScreen(model: DriveViewModel, state: DriveState, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var selected by rememberSavedItem(model)
    var removing by remember { mutableStateOf<Offline.Entry?>(null) }
    var removingFolder by remember { mutableStateOf<Offline.Folder?>(null) }
    var browsing by remember { mutableStateOf<Opened?>(null) }
    val context = LocalContext.current
    BackHandler(onBack = onBack)
    LaunchedEffect(Unit) { model.refreshOffline() }
    // A kept folder opens as a folder: what is in it opens without a connection.
    browsing?.let { folder ->
        BrowseScreen(model, state, start = folder, onLeave = { browsing = null })
        return
    }
    // Files that came with a kept folder are listed under it, not one by one.
    val looseFiles = state.offline.filter { it.via == null }
    val open = { entry: Offline.Entry ->
        val file = Offline.file(context, entry)
        if (file.exists()) openWith(context, androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file), entry.mime, model, entry.name)
    }
    Column(Modifier.fillMaxSize()) {
        DestinationBar("On this phone", onBack = onBack)
        if (state.unreachable) OfflineCapsule()
        if (state.offline.isEmpty() && state.keptFolders.isEmpty()) {
            EmptyState("Nothing on this phone yet", "Choose Keep on this phone on any file or folder to open it without a connection.", Icons.Outlined.Smartphone, modifier = Modifier.padding(top = 120.dp))
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "about") {
                Text("These open without a connection. When one changes somewhere else, the copy here updates. Long-press to remove one.",
                    style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(start = AlpineSpace.S4, end = AlpineSpace.S4, bottom = AlpineSpace.S2))
            }
            items(state.keptFolders, key = { "folder-" + it.id }) { kept ->
                val files = state.offline.filter { it.via == kept.id }
                // The failure count is added by the row itself, in red.
                val note = listOfNotNull(if (files.size == 1) "1 file" else "${files.size} files", files.mapNotNull { it.size }.takeIf { it.isNotEmpty() }?.let { formatBytes(it.sum()) }).joinToString(" · ")
                val folder = model.item(kept.id)
                if (folder != null) NodeRow(model, state, folder, note = note, onClick = { browsing = folder }, onLongClick = { removingFolder = kept }, onMore = { selected = folder })
                else Row(
                    // A kept folder this session cannot open in the tree yet: its name and what it holds.
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).combinedClickable(onClick = {}, onLongClick = { removingFolder = kept }).padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Folder, null, tint = alpine.inkMuted) }
                    Column(Modifier.padding(start = AlpineSpace.S4)) {
                        Text(kept.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(note, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                }
            }
            items(looseFiles, key = { it.id }) { entry ->
                val item = model.item(entry.id)
                val size = entry.size?.let { formatBytes(it) } ?: item?.size?.let { formatBytes(it) }
                if (item != null) NodeRow(model, state, item, note = size ?: "", onClick = { open(entry) }, onLongClick = { removing = entry }, onMore = { selected = item })
                else Row(
                    // A kept file this session cannot name in the tree yet: its name and size, nothing more.
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).combinedClickable(onClick = { open(entry) }, onLongClick = { removing = entry }).padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Smartphone, null, tint = alpine.inkMuted) }
                    Column(Modifier.padding(start = AlpineSpace.S4)) {
                        Text(entry.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        size?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted) }
                    }
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
    selected?.let { item -> ItemActions(model, state, item) { selected = null } }
    removingFolder?.let { kept ->
        AlertDialog(
            onDismissRequest = { removingFolder = null },
            title = { Text("Remove from this phone?") },
            text = { Text("“${kept.name}” and everything in it stay in HushOS. You can keep it on this phone again any time.") },
            confirmButton = { TextButton(onClick = { model.forgetKeptFolder(kept.id); removingFolder = null; model.notify("Removed “${kept.name}” from this phone. It’s still in HushOS.") }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { removingFolder = null }) { Text("Cancel") } },
        )
    }
    removing?.let { entry ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove from this phone?") },
            text = { Text("“${entry.name}” stays in HushOS. You can keep it on this phone again any time.") },
            confirmButton = { TextButton(onClick = { model.forgetOffline(entry.id); removing = null; model.notify("Removed from this phone. It’s still in HushOS.") }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}
