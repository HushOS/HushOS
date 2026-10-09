package com.hushos.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.LibraryAdd
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch

/* What "Name", "Changed" and "Size" mean in each direction, said in words. */
private fun direction(key: String, ascending: Boolean) = when (key) {
    "modified" -> if (ascending) "Oldest first" else "Newest first"
    "size" -> if (ascending) "Smallest" else "Largest"
    else -> if (ascending) "A to Z" else "Z to A"
}

/*
 * Files: the top folder under one header row, each folder
 * pushed on a simple stack, a sort button over the list, Trash at the bottom of
 * long-press to select, ⋮ for the item sheet, and the + menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseScreen(model: DriveViewModel, state: DriveState, start: Opened? = null, onLeave: (() -> Unit)? = null, takesLinks: Boolean = false) {
    val alpine = Alpine.colors
    // With `start` the screen opens on that folder (a shared one, or one from Home's Recent) and Back leaves through `onLeave`.
    // The folders opened, saved as ids only (never names or keys), so a rotation, a theme or font change,
    // or the system stopping the app in the background brings you back to the same folder. After a restart
    // the ids are found again from the catalogue; until then the screen shows that it is opening.
    var savedStack by rememberSaveable(start?.id) { mutableStateOf<List<String>>(emptyList()) }
    val stack = remember(start?.id) {
        mutableStateListOf<Opened>().apply {
            start?.let { add(it) }
            for (id in savedStack.drop(size)) add(model.item(id) ?: break)
        }
    }
    var restoring by remember(start?.id) { mutableStateOf(stack.size < savedStack.size) }
    LaunchedEffect(start?.id) {
        if (restoring) {
            for (id in savedStack.drop(stack.size)) stack.add(model.find(id) ?: break)
            restoring = false
        }
        androidx.compose.runtime.snapshotFlow { stack.map { it.id } }.collect { if (!restoring) savedStack = it }
    }
    if (restoring) {
        OpeningScreen()
        return
    }
    val current = stack.lastOrNull()
    val folderId = current?.id ?: state.rootId
    val isTop = current == null
    val floor = if (start != null) 1 else 0
    val folderName = current?.name ?: "Files"
    var fabOpen by rememberSaveable { mutableStateOf(false) }
    DisposableEffect(fabOpen) {
        model.addMenu(fabOpen)
        onDispose { if (fabOpen) model.addMenu(false) }
    }
    // An open item sheet, saved as the item's id and which sheet, and found again after a restore.
    var savedSheet by rememberSaveable { mutableStateOf<String?>(null) }
    var sheetFor by remember { mutableStateOf(savedSheet?.split('|')?.let { (id, sheet) -> model.item(id)?.let { it to ItemSheet.valueOf(sheet) } }) }
    LaunchedEffect(sheetFor) { savedSheet = sheetFor?.let { (item, sheet) -> "${item.id}|${sheet.name}" } }
    // Opened by a long press on a tile: the sheet then starts with Select, the grid's only way into selecting from an item.
    var sheetSelects by rememberSaveable { mutableStateOf(false) }
    // The share sheet (from a row or the folder's who-can-open marker), saved by id so it survives a restart.
    var sharing by rememberSavedItem(model)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val add = addInto(model, state, folderId, folderName)

    LaunchedEffect(Unit) { model.loadRoot(); model.refreshTags(); model.refreshAccess(); model.refreshOffline() }
    suspend fun openLinked(request: String) {
        val (folder, preview) = request.removePrefix("files:").split(":").let { it[0] to it.getOrElse(1) { "" } }
        val target = if (folder.isEmpty()) null else model.find(folder)
        if (folder.isNotEmpty() && (target == null || !target.isFolder)) { model.notify("This isn’t available any more."); return }
        val chain = ArrayList<Opened>()
        var cursor = target
        while (cursor != null && cursor.node.parentId != null && chain.size < 256) { chain.add(0, cursor); cursor = cursor.node.parentId?.let { model.find(it) } }
        stack.clear(); stack.addAll(chain)
        if (preview.isNotEmpty()) {
            val file = model.find(preview)
            if (file == null || file.isFolder) model.notify("This isn’t available any more.")
            else model.download(file)?.let { openWith(context, it, mimeOf(file), model, file.name) }
        }
    }

    // A link to a folder (and maybe a file in it): the folders down to it go on the stack, then the file opens.
    if (takesLinks) LaunchedEffect(state.request) {
        val request = state.request?.takeIf { it.startsWith("files:") } ?: return@LaunchedEffect
        // Cleared first, then worked on in the screen's scope: clearing restarts this effect, which would cancel it.
        model.clearRequest()
        scope.launch {
            openLinked(request)
            // A launcher shortcut's action, in the folder just opened: the + menu's own.
            when (model.takeShortcut()) {
                "UPLOAD_FILES" -> add.pickFiles()
                "UPLOAD_PHOTOS" -> add.pickPhotos()
                "NEW_FOLDER" -> add.newFolder()
            }
        }
    }
    LaunchedEffect(state.unreachable) { if (!state.unreachable) model.refreshAccess() }
    // Whenever the folder on screen has no rows and nobody is fetching them (opened, or dropped by
    // something else), fetch them: a list must never wait on a reload nobody started.
    val missing = needsLoad(folderId, state.folders, state.loading, state.failedFolders)
    LaunchedEffect(folderId, missing) { if (missing && folderId != null) model.refresh(folderId) }
    LaunchedEffect(isTop) { if (isTop) model.refreshStorage() }
    var query by rememberSaveable { mutableStateOf("") }
    var tagFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    var selecting by rememberSaveable { mutableStateOf(false) }
    val clearSelection = { picked = emptySet(); selecting = false }
    var movingMany by remember { mutableStateOf(false) }
    var sendingMany by remember { mutableStateOf<List<Opened>?>(null) }
    var taggingMany by remember { mutableStateOf<List<Opened>?>(null) }
    var selectMenu by remember { mutableStateOf(false) }
    var folderMenu by remember { mutableStateOf(false) }
    BackHandler(enabled = stack.size > floor || onLeave != null) { if (stack.size > floor) stack.removeAt(stack.lastIndex) else onLeave?.invoke() }
    BackHandler(enabled = selecting) { clearSelection() }
    // Declared last so it wins: Back closes the add menu before it leaves a folder or the app.
    BackHandler(enabled = fabOpen) { fabOpen = false }

    // How this drive's lists are ordered, kept across launches; folders always come first.
    val prefs = context.getSharedPreferences("files", android.content.Context.MODE_PRIVATE)
    var sortKey by rememberSaveable { mutableStateOf(prefs.getString("sortKey", "name") ?: "name") }
    var sortAscending by rememberSaveable { mutableStateOf(prefs.getBoolean("sortAscending", true)) }
    var sortMenu by remember { mutableStateOf(false) }
    // Rows or tiles, one choice for every folder on this phone.
    var view by rememberSaveable { mutableStateOf(prefs.getString("files.view", "list") ?: "list") }
    // A tag filter and a search belong to the folder they were set in; opening another folder starts clear.
    var filteredIn by rememberSaveable { mutableStateOf(folderId) }
    LaunchedEffect(folderId) { if (filteredIn != folderId) { filteredIn = folderId; tagFilter = null; query = ""; clearSelection() } }
    val listState = key(folderId) { rememberLazyListState() }
    // A new order starts at the top, once the list holds it; scrolling earlier would still follow the anchored row.
    var sortSeen by remember { mutableStateOf(sortKey to sortAscending) }
    LaunchedEffect(sortKey, sortAscending) {
        if (sortSeen != (sortKey to sortAscending)) { sortSeen = sortKey to sortAscending; listState.scrollToItem(0) }
    }
    val here = folderId?.let { state.folders[it] } ?: emptyList()
    val loaded = folderId != null && state.folders.containsKey(folderId)
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    // "Search in {folder}" looks through everything below this folder, not the whole drive.
    val unfiltered = if (words.isEmpty()) sortItems(here, sortKey, sortAscending)
        else model.searchable().filter { item -> folderId != null && item.id != folderId && words.all { item.name.lowercase().contains(it) } && isBelow(model, item, folderId) }
            .sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    val items = tagFilter?.let { id -> unfiltered.filter { it.id in state.tags.nodesWith(id) } } ?: unfiltered
    // Search results stay rows whatever the choice: each needs its "In …" line.
    val grid = view == "grid" && words.isEmpty()
    val chosen = here.filter { it.id in picked }
    // Whose folder this is: someone else's that this account can only view takes no adds, moves or trash.
    val owner = (current ?: state.rootId?.let { model.item(it) })?.let { ownerOf(model, state, it) } ?: Owner.ME
    val clip = state.clipboard
    val pasteProblem = if (clip != null && folderId != null) model.pasteProblem(folderId) else null
    val pasteText = clip?.first?.let { if (it.size == 1) "Paste “${it[0].name}” here" else "Paste ${it.size} items here" }
    val showPaste = clip != null && !selecting && folderId != null

    // Per folder: a bar hidden by scrolling one folder must not stay hidden in the next, where an empty
    // list cannot scroll to bring it (and its back arrow) back.
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior(key(folderId) { rememberTopAppBarState() })
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        containerColor = alpine.ground,
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            if (selecting) {
                // The contextual bar: the same actions, in the same order, as iOS and the web.
                TopAppBar(
                    title = { Text("${picked.size} selected") },
                    navigationIcon = { IconButton(onClick = clearSelection) { Icon(Icons.Outlined.Close, "Clear selection") } },
                    actions = {
                        val one = chosen.singleOrNull()
                        // Each icon says what it does, aloud and on a long press.
                        if (owner == Owner.ME) Labelled("Share") { IconButton(enabled = one != null, onClick = { sharing = one }) { Icon(Icons.Outlined.Share, "Share") } }
                        if (owner != Owner.VIEW) Labelled("Move") { IconButton(enabled = chosen.isNotEmpty(), onClick = { movingMany = true }) { Icon(Icons.AutoMirrored.Outlined.DriveFileMove, "Move") } }
                        Labelled("Copy") { IconButton(enabled = chosen.isNotEmpty(), onClick = { /* The paste bar is the confirmation: no notice over it. */ model.copy(chosen); clearSelection() }) { Icon(Icons.Outlined.ContentCopy, "Copy") } }
                        if (owner != Owner.VIEW) Labelled("Move to Trash") { IconButton(enabled = chosen.isNotEmpty(), onClick = { model.trashAll(chosen); clearSelection() }) { Icon(Icons.Outlined.Delete, "Move to Trash") } }
                        Box {
                            IconButton(onClick = { selectMenu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                            DropdownMenu(expanded = selectMenu, onDismissRequest = { selectMenu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                                // Several files go out together; folders can't be sent.
                                DropdownMenuItem(text = { Text("Send a copy") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Send, null) }, enabled = chosen.isNotEmpty() && chosen.none { it.isFolder },
                                    onClick = { selectMenu = false; sendingMany = chosen; clearSelection() })
                                if (owner != Owner.VIEW) DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, enabled = one != null,
                                    onClick = { selectMenu = false; one?.let { sheetSelects = false; sheetFor = it to ItemSheet.RENAME }; clearSelection() })
                                if (owner == Owner.ME) DropdownMenuItem(text = { Text("Tags") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Label, null) }, enabled = chosen.isNotEmpty(),
                                    onClick = { selectMenu = false; taggingMany = chosen; clearSelection() })
                                if (owner != Owner.ME) DropdownMenuItem(text = { Text("Save a copy to my files") }, leadingIcon = { Icon(Icons.Outlined.LibraryAdd, null) }, enabled = chosen.isNotEmpty(),
                                    onClick = { selectMenu = false; model.saveCopy(chosen); clearSelection() })
                                val all = here.isNotEmpty() && picked.size == here.size
                                DropdownMenuItem(text = { Text(if (all) "Deselect all" else "Select all") }, leadingIcon = { Icon(Icons.Outlined.CheckCircleOutline, null) },
                                    onClick = { selectMenu = false; picked = if (all) emptySet() else here.map { it.id }.toSet() })
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = alpine.tint, scrolledContainerColor = alpine.tint, titleContentColor = alpine.onTint, navigationIconContentColor = alpine.onTint, actionIconContentColor = alpine.onTint),
                )
            } else {
                // One row: back (inside a folder), the title, and the folder's ⋮ menu.
                DestinationBar(
                    if (isTop) "Files" else folderName,
                    onBack = if (isTop) null else ({ if (stack.size > floor) stack.removeAt(stack.lastIndex) else onLeave?.invoke() }),
                    scrollBehavior = scroll,
                ) {
                    Box {
                        IconButton(onClick = { folderMenu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                        DropdownMenu(expanded = folderMenu, onDismissRequest = { folderMenu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                            // Selecting is not an add action, so it lives here (and on a long press), not in the + menu.
                            DropdownMenuItem(text = { Text("Select", style = MaterialTheme.typography.bodyLarge) }, leadingIcon = { Icon(Icons.Outlined.CheckCircleOutline, null) }, enabled = here.isNotEmpty(),
                                onClick = { folderMenu = false; selecting = true })
                        }
                    }
                }
            }
        },
        floatingActionButton = {
            if (!selecting && owner != Owner.VIEW) AddButton(
                fabOpen, { fabOpen = it }, add, lift = if (showPaste) 80.dp else 0.dp,
                paste = if (clip != null && pasteProblem == null && folderId != null) (if (clip.first.size == 1) "Paste “${clip.first[0].name}”" else "Paste ${clip.first.size} items") to { model.paste(folderId); Unit } else null,
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            // The spinner follows the refresh, not every write: an upload waiting out a dead network must not look like a stuck pull.
            PullToRefreshBox(
                isRefreshing = loaded && folderId in state.loading,
                onRefresh = { folderId?.let { model.refresh(it, pulled = true) }; model.refreshAccess(); if (isTop) model.refreshStorage() },
                modifier = Modifier.fillMaxSize(),
            ) {
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val columns = gridColumns(maxWidth)
                    LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = (if (showPaste) 168.dp else 88.dp) + LocalFootBars.current)) {
                        item(key = "header") {
                            Column {
                                // Who can open everything here, once, right under the title, for a folder this account shared (or one
                                // inside it). It stays while searching: the field under it must not move as you type.
                                if (state.unreachable) OfflineCapsule()
                                if (!isTop) TextField(
                                    value = query, onValueChange = { query = it }, singleLine = true,
                                    placeholder = { Text("Search in $folderName", maxLines = 1) },
                                    leadingIcon = { Icon(Icons.Outlined.Search, null, tint = alpine.ink) },
                                    trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear search") } },
                                    shape = CircleShape,
                                    colors = TextFieldDefaults.colors(
                                        focusedContainerColor = alpine.fill, unfocusedContainerColor = alpine.fill,
                                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                                        unfocusedPlaceholderColor = alpine.inkMuted, focusedPlaceholderColor = alpine.inkMuted,
                                    ),
                                    modifier = Modifier.fillMaxWidth().padding(start = AlpineSpace.S4, end = AlpineSpace.S4, bottom = AlpineSpace.S3)
                                        .then(if (alpine.high) Modifier.border(1.dp, alpine.field, CircleShape) else Modifier),
                                )
                                // Who can open everything here, once, for a folder this account shared (or one inside it).
                                val access = state.access
                                val own = state.rootId?.let { model.item(it) }?.node?.workspaceId
                                val shown = current ?: state.rootId?.let { model.item(it) }
                                if (shown != null && access != null && shown.node.workspaceId == own && words.isEmpty()) {
                                    sharedAbove(model, access, shown, self = true)?.let { (folder, who) -> AccessBanner(bannerText(who), onManage = { sharing = folder }, linked = who.links > 0) }
                                }
                                if (words.isEmpty() && loaded && (here.isNotEmpty() || tagFilter != null)) Row(
                                    Modifier.fillMaxWidth().height(48.dp).padding(horizontal = AlpineSpace.S2),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box {
                                        Row(
                                            Modifier.height(36.dp).background(Color.Transparent, CircleShape).clickable(role = Role.Button) { sortMenu = true }
                                                .semantics { contentDescription = "View, sort and show only. ${if (view == "grid") "Grid" else "List"}, sorted by ${sortLabel(sortKey)}, ${direction(sortKey, sortAscending)}" }
                                                .padding(horizontal = AlpineSpace.S3),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Icon(Icons.Outlined.SwapVert, null, tint = alpine.ink, modifier = Modifier.size(18.dp))
                                            Text(sortLabel(sortKey), style = MaterialTheme.typography.labelLarge, color = alpine.ink, modifier = Modifier.padding(horizontal = 6.dp))
                                            Icon(if (sortAscending) Icons.Outlined.ArrowUpward else Icons.Outlined.ArrowDownward, null, tint = alpine.inkMuted, modifier = Modifier.size(16.dp))
                                        }
                                        SortMenu(
                                            expanded = sortMenu, dismiss = { sortMenu = false }, view = view, sortKey = sortKey, ascending = sortAscending,
                                            onView = { choice -> view = choice; prefs.edit().putString("files.view", choice).apply(); sortMenu = false },
                                            tags = state.tags.tags.filter { tag -> here.any { it.id in state.tags.nodesWith(tag.id) } }, tagFilter = tagFilter,
                                            onSort = { key ->
                                                if (key == sortKey) sortAscending = !sortAscending else { sortKey = key; sortAscending = key == "name" }
                                                prefs.edit().putString("sortKey", sortKey).putBoolean("sortAscending", sortAscending).apply()
                                                sortMenu = false
                                            },
                                            onTag = { id -> tagFilter = if (tagFilter == id) null else id; sortMenu = false },
                                        )
                                    }
                                    state.tags.tags.firstOrNull { it.id == tagFilter }?.let { tag ->
                                        // The filter says so where the rows are, so a shorter list never looks like missing files.
                                        AlpineChip(tag.name, selected = true, onClick = { tagFilter = null })
                                        Spacer(Modifier.weight(1f))
                                        TextButton(onClick = { tagFilter = null }) { Text("Show all") }
                                    }
                                }
                            }
                        }
                        when {
                            words.isNotEmpty() && items.isEmpty() -> item(key = "none") {
                                EmptyState("No results for “${query.trim()}”", "Check the spelling, or try fewer words.", Icons.Outlined.Search, modifier = Modifier.padding(top = 48.dp))
                            }
                            folderId != null && folderId in state.failedFolders && !loaded -> item(key = "failed") {
                                EmptyState("This folder couldn’t be opened", "The connection dropped while it was loading. Nothing in it has changed.", Icons.Outlined.WarningAmber, danger = true, modifier = Modifier.padding(top = 96.dp)) {
                                    Button(onClick = { model.refresh(folderId) }) { Text("Try again") }
                                }
                            }
                            !loaded && state.unreachable && (folderId == null || folderId !in state.loading) -> item(key = "offline") {
                                // Nothing on this phone for this folder and no network to fetch it: say so instead of a blank list.
                                EmptyState("Not opened on this phone yet", "“$folderName” hasn’t been opened here before, so there’s nothing to show offline. It opens when you’re back online.", Icons.Outlined.CloudOff, modifier = Modifier.padding(top = 96.dp))
                            }
                            !loaded -> item(key = "loading") { if (grid) SkeletonTiles(columns) else SkeletonRows() }
                            items.isEmpty() && tagFilter != null -> item(key = "untagged") {
                                val name = state.tags.tags.firstOrNull { it.id == tagFilter }?.name ?: ""
                                EmptyState("Nothing tagged $name", "Nothing in this folder carries this tag.", modifier = Modifier.padding(top = 64.dp))
                            }
                            items.isEmpty() -> item(key = "empty") {
                                EmptyState("Nothing here yet", "Use + to add files, or save to HushOS from the Files app.", Icons.Outlined.CreateNewFolder, modifier = Modifier.padding(top = 64.dp, bottom = 32.dp))
                            }
                        }
                        fun open(item: Opened) {
                            if (item.isFolder) { query = ""; stack.add(item) }
                            else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item), model, item.name) } }
                        }
                        fun toggle(item: Opened) { picked = if (item.id in picked) picked - item.id else picked + item.id }
                        // Offline, a file that isn't on this phone can't open: it dims and says so.
                        fun away(item: Opened) = state.unreachable && !item.isFolder && state.offline.none { it.id == item.id }
                        if (grid) items(items.chunked(columns), key = { "tiles:" + it.first().id }) { line ->
                            TileRow(columns, line.size) { slot ->
                                val item = line[slot]
                                NodeTile(model, state, item,
                                    onClick = { if (selecting) toggle(item) else open(item) },
                                    // There is no room for ⋮: a long press opens the item sheet, as in Photos; while selecting it toggles, as a row's does.
                                    onLongClick = { if (selecting) toggle(item) else { sheetSelects = true; sheetFor = item to ItemSheet.MENU } },
                                    onActions = if (selecting) null else ({ sheetSelects = true; sheetFor = item to ItemSheet.MENU }),
                                    selecting = selecting, selected = item.id in picked, away = away(item))
                            }
                        } else items(items, key = { it.id }) { item ->
                            NodeRow(model, state, item,
                                note = if (words.isEmpty()) null else "In " + (item.node.parentId?.let { if (it == state.rootId) "Files" else model.item(it)?.name } ?: "Files"),
                                onClick = { if (selecting) toggle(item) else open(item) },
                                // Long-press starts selecting, as Material lists do; ⋮ opens the item sheet.
                                onLongClick = { if (!selecting) { selecting = true; picked = setOf(item.id) } else toggle(item) },
                                onMore = { sheetSelects = false; sheetFor = item to ItemSheet.MENU },
                                selecting = selecting, selected = item.id in picked,
                                away = away(item))
                        }
                    }
                }
            }
            if (showPaste && pasteText != null) {
                PasteBar(pasteText, pasteProblem, onPaste = { model.paste(folderId) }, onClear = { model.clearClipboard() }, modifier = Modifier.align(Alignment.BottomCenter))
            }
        }
    }
    if (movingMany) MovePicker(model, state, chosen) { movingMany = false; clearSelection() }
    sharing?.let { item -> ShareSheet(model, state, item) { sharing = null; clearSelection(); model.refreshAccess() } }
    sendingMany?.let { items -> SendCopy(model, state, items) { sendingMany = null } }
    taggingMany?.let { items -> ItemTagsSheet(model, state, items) { taggingMany = null } }
    sheetFor?.let { (item, open) ->
        ItemActions(model, state, item, open = open, onSelect = if (sheetSelects) ({ selecting = true; picked = setOf(item.id) }) else null) { sheetFor = null; model.refreshAccess() }
    }
}

/* Whether `item` sits somewhere below `folder`. */
private fun isBelow(model: DriveViewModel, item: Opened, folder: String): Boolean {
    var cursor = item.node.parentId
    var steps = 0
    while (cursor != null && steps++ < 256) {
        if (cursor == folder) return true
        cursor = model.item(cursor)?.node?.parentId
    }
    return false
}

/* The sort button's menu: View (list or grid), then Sort by with a check and the direction in words, then Show only with this folder's tags. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SortMenu(expanded: Boolean, dismiss: () -> Unit, view: String, sortKey: String, ascending: Boolean, tags: List<com.hushos.app.data.Tag>, tagFilter: String?, onView: (String) -> Unit, onSort: (String) -> Unit, onTag: (String) -> Unit) {
    val alpine = Alpine.colors
    DropdownMenu(expanded = expanded, onDismissRequest = dismiss, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu, modifier = Modifier.width(264.dp)) {
        Text("View", style = MaterialTheme.typography.titleSmall, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
        for ((key, label) in listOf("list" to "List", "grid" to "Grid")) {
            val on = key == view
            DropdownMenuItem(
                text = { Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = if (on) FontWeight.Medium else null) },
                trailingIcon = if (on) ({ Icon(Icons.Outlined.Check, null, tint = alpine.onTint) }) else null,
                onClick = { onView(key) },
                modifier = if (on) Modifier.background(alpine.tint) else Modifier,
            )
        }
        HorizontalDivider(Modifier.padding(vertical = AlpineSpace.S2), color = alpine.divider)
        Text("Sort by", style = MaterialTheme.typography.titleSmall, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
        for (key in listOf("name", "modified", "size")) {
            val on = key == sortKey
            DropdownMenuItem(
                text = { Text(sortLabel(key), style = MaterialTheme.typography.bodyLarge, fontWeight = if (on) FontWeight.Medium else null) },
                trailingIcon = if (on) ({
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(direction(key, ascending), style = MaterialTheme.typography.bodySmall, color = alpine.onTint, modifier = Modifier.padding(end = AlpineSpace.S2))
                        Icon(Icons.Outlined.Check, null, tint = alpine.onTint)
                    }
                }) else null,
                // Tapping the order in force reverses it.
                onClick = { onSort(key) },
                modifier = if (on) Modifier.background(alpine.tint) else Modifier,
            )
        }
        HorizontalDivider(Modifier.padding(vertical = AlpineSpace.S2), color = alpine.divider)
        Text("Show only", style = MaterialTheme.typography.titleSmall, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
        if (tags.isEmpty()) Text("No tags in this folder", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
        else FlowRow(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S1), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
            for (tag in tags) AlpineChip(tag.name, selected = tag.id == tagFilter, onClick = { onTag(tag.id) }, leading = { TagDot(tag.colour) })
        }
    }
}

/* An icon button that says what it does on a long press, as the selection bar's tooltips. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Labelled(label: String, content: @Composable () -> Unit) {
    androidx.compose.material3.TooltipBox(
        positionProvider = androidx.compose.material3.TooltipDefaults.rememberTooltipPositionProvider(androidx.compose.material3.TooltipAnchorPosition.Below),
        tooltip = {
            val alpine = Alpine.colors
            Text(label, color = alpine.onSnackbar, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.background(alpine.snackbar, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 4.dp))
        },
        state = androidx.compose.material3.rememberTooltipState(),
    ) { content() }
}
