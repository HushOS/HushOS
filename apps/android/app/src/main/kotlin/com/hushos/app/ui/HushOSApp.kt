package com.hushos.app.ui

import androidx.compose.runtime.remember
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.layout.fillMaxHeight
import com.hushos.tokens.AlpineSpace
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.background
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.NavigationBarItemDefaults
import kotlinx.coroutines.launch
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material3.AlertDialog
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.IconButton
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/* The gate, then Home, Files, Shared and Account as bottom tabs. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSApp(model: DriveViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    // Account recovery, signed in or out: its own screens until the new phrase, which is saved signed in.
    model.recovery?.let { flow ->
        if (flow.step != DriveViewModel.RecoveryStep.NEW_PHRASE) { RecoverScreen(model, state); return }
        if (state.gate == Gate.SIGNED_IN) { PhraseScreen(model, fresh = flow.newPhrase) { model.leaveRecovery() }; return }
    }
    when (state.gate) {
        Gate.CHECKING -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        Gate.SIGNED_OUT -> if (state.accountDeleted) AccountDeletedScreen(onDone = model::clearSignedOut) else SignInScreen(model, state)
        Gate.SIGNED_IN -> {
            // While the app is on screen the lists follow the server, as the web's feed does; in the background nothing polls.
            val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
            LaunchedEffect(lifecycle) {
                lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.RESUMED) {
                    // Back in front: kept folders (shared ones too) are looked at now, not at the next tick.
                    model.onForeground()
                    while (true) { kotlinx.coroutines.delay(10_000); model.liveSync() }
                }
            }
            Main(model, state)
        }
    }
    // A session that ended on its own gets its own words, not "Something went wrong".
    if (state.signedOutNotice && state.gate == Gate.SIGNED_OUT) AlertDialog(
        onDismissRequest = model::clearSignedOut,
        title = { Text("You’ve been signed out") },
        text = { Text("Your session ended, perhaps because your password was changed on another device. Sign in again to carry on.") },
        confirmButton = { TextButton(onClick = model::clearSignedOut) { Text("Sign in") } },
    )
    // What happened and what to do, in plain words; the raw detail only behind Details.
    state.error?.let { problem ->
        var details by remember(problem) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = model::clearError,
            confirmButton = { TextButton(onClick = model::clearError) { Text("OK") } },
            dismissButton = problem.detail?.takeIf { !details && it != problem.body }?.let { { TextButton(onClick = { details = true }) { Text("Details") } } },
            title = { Text(problem.title) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                    Text(problem.body)
                    if (details) problem.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted) }
                }
            },
        )
    }
}

private enum class Tab(val label: String) { HOME("Home"), FILES("Files"), SHARED("Shared"), ACCOUNT("Account") }

@Composable
private fun Main(model: DriveViewModel, state: DriveState) {
    val alpine = Alpine.colors
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    // Which page of Home is up ("home", "search", "phone", "folder:<id>"), kept here so a notice can open one.
    var home by rememberSaveable { mutableStateOf("home") }
    // Here rather than in the panel, which leaves the screen while the add menu is open.
    var transfersOpen by rememberSaveable { mutableStateOf(false) }
    // Not enough room for an upload: the three ways out, from the transfers sheet's Make room.
    var makingRoom by rememberSaveable { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    LaunchedEffect(state.request) {
        val request = state.request ?: return@LaunchedEffect
        when {
            request == "phone" -> { tab = Tab.HOME; home = "phone"; model.clearRequest() }
            request == "home" -> { tab = Tab.HOME; home = "home"; model.clearRequest() }
            // Launcher shortcuts: Search, or the folder last added to with the + menu's action (BrowseScreen runs it).
            request == "search" -> { tab = Tab.HOME; home = "search"; model.clearRequest() }
            request == "shortcut" -> scope.launch {
                model.clearRequest()
                val folder = model.lastFolder()
                tab = Tab.FILES
                model.openRequest("files:${folder.orEmpty()}:")
            }
            // The transfer notification's tap.
            request == "transfers" -> { transfersOpen = true; model.clearRequest() }
            // These are taken (and cleared) by the screen they open: the link browser, a folder, By me, Trash.
            request.startsWith("link:") || request.startsWith("shared:") -> tab = Tab.SHARED
            request.startsWith("files:") -> tab = Tab.FILES
            request == "trash" -> tab = Tab.ACCOUNT
            request.startsWith("node:") -> scope.launch {
                // A file or a folder, whichever it is: a folder opens, a file opens in its folder.
                model.clearRequest()
                val item = model.find(request.removePrefix("node:"))
                when {
                    item == null -> model.notify("This isn’t available any more.")
                    item.isFolder -> model.openRequest("files:${item.id}:")
                    else -> model.openRequest("files:${item.node.parentId.orEmpty()}:${item.id}")
                }
            }
            else -> model.clearRequest()
        }
    }
    // A sheet is its own window above this screen: it draws the notice too, so feedback is never hidden under it.
    CompositionLocalProvider(LocalNotice provides { state.notice?.let { NoticeBar(it, model, Modifier.padding(12.dp)) } }) {
    Scaffold(
        containerColor = alpine.ground,
        bottomBar = {
            // Search takes the whole screen, as Material's search view does.
            if (!(tab == Tab.HOME && home == "search")) Column {
            // High contrast has no shadows or tonal steps, so a rule marks where the list ends.
            if (alpine.high) androidx.compose.material3.HorizontalDivider(color = alpine.divider)
            NavigationBar(containerColor = alpine.surface) {
                for (entry in Tab.entries) {
                    val on = tab == entry
                    NavigationBarItem(
                        selected = on,
                        onClick = { if (on && entry == Tab.HOME) home = "home"; tab = entry },
                        icon = {
                            // Selected is a filled icon in the tint pill with an ink label, never the tint alone.
                            Icon(
                                when (entry) {
                                    Tab.HOME -> if (on) Icons.Filled.Home else Icons.Outlined.Home
                                    Tab.FILES -> if (on) Icons.Filled.Folder else Icons.Outlined.Folder
                                    Tab.SHARED -> if (on) Icons.Filled.Group else Icons.Outlined.Group
                                    Tab.ACCOUNT -> if (on) Icons.Filled.Person else Icons.Outlined.Person
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(entry.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = alpine.onTint, indicatorColor = alpine.tint, selectedTextColor = alpine.ink,
                            unselectedIconColor = alpine.inkMuted, unselectedTextColor = alpine.inkMuted,
                        ),
                    )
                }
            }
            }
        },
        snackbarHost = {
            Column {
                // Above the add button and the paste bar, which sit over this corner on Files and would cover Undo.
                val lift = when {
                    tab != Tab.FILES -> 0.dp
                    state.clipboard != null -> 152.dp
                    else -> 76.dp
                }
                state.notice?.let { notice ->
                    NoticeBar(notice, model, Modifier.padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = if (state.transfers.isEmpty() && state.queued.isEmpty()) lift else 0.dp))
                }
                val all = state.queued + state.transfers
                if (all.isNotEmpty() && !state.addMenuOpen) Box(Modifier.padding(bottom = lift)) { TransferBar(all, offline = state.unreachable) { transfersOpen = true } }
            }
        },
    ) { padding ->
        Box(Modifier.padding(bottom = padding.calculateBottomPadding())) {
            when (tab) {
                Tab.HOME -> HomeScreen(model, state, home, go = { home = it })
                Tab.FILES -> BrowseScreen(model, state, takesLinks = true)
                Tab.SHARED -> SharedScreen(model, state)
                Tab.ACCOUNT -> AccountScreen(model, state)
            }
        }
    }
    if (transfersOpen) TransferSheet(model, state.queued + state.transfers, state.unreachable, makeRoom = { transfersOpen = false; makingRoom = true }) { transfersOpen = false }
    if (makingRoom) StorageFullSheet(model, state, (state.queued + state.transfers).filter { it.noRoom }) { makingRoom = false }
    BackgroundSheet(active = state.queued.any { !it.done })
    }
}

/*
 * Android 13 and later ask before an app shows notifications. The first time
 * something is queued in the background, HushOS says why it wants to (the
 * transfer notification) before the system asks; "Not now" isn't asked again.
 */
@Composable
fun rememberBackgroundAccess(): com.hushos.app.data.BackgroundAccess {
    val context = androidx.compose.ui.platform.LocalContext.current
    var access by remember { mutableStateOf(com.hushos.app.data.Background.read(context)) }
    // Read again whenever HushOS comes back, from Settings or anywhere else.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) access = com.hushos.app.data.Background.read(context)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return access
}

/*
 * Asked when a transfer or a keep starts in the background queue, never at launch, and
 * only when something would stop it there: notifications off, battery optimisation on,
 * or Data Saver blocking HushOS. Each says what it does in a line and has its own button;
 * "Not now" is remembered for a week.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun BackgroundSheet(active: Boolean) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("asked", android.content.Context.MODE_PRIVATE) }
    val access = rememberBackgroundAccess()
    var showing by remember { mutableStateOf(false) }
    LaunchedEffect(active) {
        val notNow = prefs.getLong("background-not-now", 0L).takeIf { it > 0L }
        if (active && com.hushos.app.data.Background.shouldAsk(com.hushos.app.data.Background.read(context), notNow, System.currentTimeMillis())) showing = true
    }
    // Everything turned on in Settings meanwhile: nothing left to ask.
    LaunchedEffect(access) { if (access.allSet) showing = false }
    if (!showing) return
    val notNow = { showing = false; prefs.edit().putLong("background-not-now", System.currentTimeMillis()).apply() }
    Sheet(onDismissRequest = notNow) { BackgroundAsk(access, notNow) }
}

/* The prompt's body: what is off, a line and a button each, and Not now. Save to HushOS asks with it too. */
@Composable
fun BackgroundAsk(access: com.hushos.app.data.BackgroundAccess, notNow: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("asked", android.content.Context.MODE_PRIVATE) }
    val ask = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) {}
    val open = { intent: android.content.Intent -> runCatching { context.startActivity(intent) } }
    Column(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
        Text("Let HushOS finish transfers in the background", style = MaterialTheme.typography.titleLarge)
        if (!access.notifications) BackgroundRow("A notification shows how far a transfer has got, so you can leave the app.", "Allow notifications") {
            // The system prompt once; after that, only Settings can turn it on.
            if (com.hushos.app.data.Background.asksForNotifications && !prefs.getBoolean("notifications", false)) {
                prefs.edit().putBoolean("notifications", true).apply(); ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            } else open(com.hushos.app.data.Background.notificationSettings(context))
        }
        if (!access.battery) BackgroundRow("Battery optimisation can pause uploads when you leave the app. In the list, choose HushOS and turn it off.", "Open settings") {
            open(com.hushos.app.data.Background.batterySettings())
        }
        if (!access.data) BackgroundRow("Data Saver is stopping HushOS from using data in the background.", "Open settings") {
            open(com.hushos.app.data.Background.dataSettings(context))
        }
        TextButton(onClick = notNow, modifier = Modifier.align(Alignment.End)) { Text("Not now") }
    }
}

@Composable
private fun BackgroundRow(text: String, action: String, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted)
        OutlinedButton(onClick = onClick) { Text(action) }
    }
}

/* A notice: its words, and the one thing to do about it (Undo, Show, Open). */
@Composable
fun NoticeBar(notice: Notice, model: DriveViewModel, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    Snackbar(
        modifier = modifier,
        shape = MaterialTheme.shapes.extraSmall,
        containerColor = alpine.snackbar, contentColor = alpine.onSnackbar,
        action = notice.undo?.let { undo -> { TextButton(onClick = { model.dismissNotice(); undo() }, colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = alpine.snackbarAction)) { Text(notice.action) } } },
    ) { Text(notice.text, maxLines = 3) }
}

/* What kind of transfer a row is, in the board's terms: up, down, or kept on this phone. */
private fun direction(item: TransferItem) = when (item.kind) { "keep" -> "keep"; "download" -> "down"; else -> "up" }

private fun plural(n: Int, one: String, many: String = "${one}s") = "$n ${if (n == 1) one else many}"

/* The one headline the bar, the sheet and the notification share. */
fun transferHeadline(list: List<TransferItem>, offline: Boolean): String {
    val running = list.filter { !it.done }
    if (running.isNotEmpty()) {
        if (offline && running.all { it.waiting }) return "Waiting for a connection"
        val dirs = running.map(::direction).toSet()
        // A kept folder is one job for everything in it, named as itself.
        if (running.size == 1 && running[0].folder) return "Keeping “${running[0].name}” on this phone"
        val n = when {
            running.all { it.folder } -> plural(running.size, "folder")
            running.any { it.folder } -> plural(running.size, "item")
            else -> plural(running.size, "file")
        }
        return when {
            dirs.size > 1 -> "Transferring $n"
            "up" in dirs -> "Uploading $n"
            "down" in dirs -> "Downloading $n"
            else -> "Keeping $n on this phone"
        }
    }
    val failed = list.count { it.failed }
    if (failed > 0) return "${plural(failed, "transfer")} didn’t finish"
    val done = list.filter { it.done }
    if (done.isNotEmpty() && done.all { direction(it) == "up" }) return "${plural(done.size, "file")} uploaded"
    return if (done.isEmpty()) "No transfers" else "${plural(done.size, "transfer")} finished"
}

/* A failure's reason, in words that say what to do. */
fun transferReason(item: TransferItem): String = com.hushos.app.data.TransferQueue.reasonWords(item.message)

/* A row's own line: waiting, how far, or how it ended. */
private fun statusLine(item: TransferItem, offline: Boolean): String = when {
    item.failed -> transferReason(item)
    item.done -> when (direction(item)) { "keep" -> "On this phone"; "down" -> "Downloaded"; else -> "Uploaded" }
    item.waiting -> if (offline) "Waiting for a connection" else "Waiting"
    // A kept folder: how many of its files are done, the bar measuring bytes.
    item.files != null -> "${item.files.first} of ${item.files.second} files" + if (item.fraction > 0f) " · ${(item.fraction * 100).toInt()}%" else ""
    item.fraction <= 0f -> "Preparing"
    else -> "${(item.fraction * 100).toInt()}%"
}

/*
 * Transfers, collapsed: a card above the navigation bar with the shared headline
 * and how many are done; a tap opens the sheet with every file. It steps aside
 * while the add menu is open.
 */
@Composable
private fun TransferBar(transfers: List<TransferItem>, offline: Boolean, onOpen: () -> Unit) {
    val alpine = Alpine.colors
    val shape = RoundedCornerShape(com.hushos.tokens.AlpineRadius.Card)
    val running = transfers.filter { !it.done }
    Row(
        Modifier.fillMaxWidth().padding(12.dp).raised(shape).background(alpine.card, shape).clip(shape).clickable(onClick = onOpen).heightIn(min = 64.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            running.isNotEmpty() && !(offline && running.all { it.waiting }) ->
                CircularProgressIndicator(progress = { transfers.map { if (it.done) 1f else it.fraction }.average().toFloat() }, modifier = Modifier.size(24.dp), strokeWidth = 3.dp)
            running.isNotEmpty() -> Icon(Icons.Outlined.CloudOff, null, tint = alpine.inkMuted)
            transfers.any { it.failed } -> Icon(Icons.Outlined.WarningAmber, null, tint = alpine.danger)
            else -> Icon(Icons.Outlined.CheckCircle, null, tint = alpine.success)
        }
        Column(Modifier.weight(1f).padding(horizontal = 16.dp)) {
            Text(transferHeadline(transfers, offline), style = MaterialTheme.typography.bodyLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
            Text("${transfers.count { it.done && !it.failed }} of ${transfers.size}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        Icon(Icons.Outlined.ExpandLess, "Open transfers", tint = alpine.inkMuted)
    }
}

/*
 * The transfers sheet: one row per file with its own bar and line; Cancel asks
 * first (the web's words), a failure says what to do and offers Retry or Remove
 * from list, and the foot has Retry failed, Clear finished and Cancel all.
 */
@Composable
fun TransferSheet(model: DriveViewModel, transfers: List<TransferItem>, offline: Boolean, makeRoom: () -> Unit, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    var cancelling by remember { mutableStateOf<List<TransferItem>?>(null) }
    var menu by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(transfers.isEmpty()) { if (transfers.isEmpty()) dismiss() }
    val failed = transfers.filter { it.failed }
    val retryable = failed.filter { !it.noRoom && it.retry != null }
    // Every failure is "not enough room": retrying can't help, so the one way on is Make room, at the foot.
    val onlyRoom = failed.isNotEmpty() && failed.all { it.noRoom }
    val running = transfers.filter { !it.done && it.cancel != null }
    Sheet(onDismissRequest = dismiss, full = true) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().padding(bottom = 16.dp)) {
            Text(transferHeadline(transfers, offline), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                for (item in transfers.sortedByDescending { it.failed }) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(36.dp).background(alpine.fill, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                            Icon(
                                when (direction(item)) { "keep", "down" -> Icons.Outlined.CloudDownload; else -> Icons.Outlined.CloudUpload },
                                null, tint = if (item.failed) alpine.danger else alpine.primary, modifier = Modifier.size(20.dp),
                            )
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            // Cut in the middle, so the start and the extension both show.
                            Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.MiddleEllipsis)
                            if (!item.done && !item.waiting) Meter(item.fraction)
                            Text(statusLine(item, offline), style = MaterialTheme.typography.bodyMedium, maxLines = 2,
                                color = when { item.failed -> alpine.danger; item.done -> alpine.success; else -> alpine.inkMuted })
                        }
                        when {
                            !item.done && item.cancel != null -> IconButton(onClick = { cancelling = listOf(item) }) { Icon(Icons.Outlined.Close, "Cancel ${item.name}") }
                            item.failed -> Row(verticalAlignment = Alignment.CenterVertically) {
                                // Out of room: Make room on the row only when other failures need Retry; otherwise it is the foot's.
                                if (item.noRoom) { if (!onlyRoom) TextButton(onClick = makeRoom) { Text("Make room") } }
                                else item.retry?.let { retry -> TextButton(onClick = retry) { Text("Retry") } }
                                Box {
                                    IconButton(onClick = { menu = item.id }) { Icon(Icons.Outlined.MoreVert, "More for ${item.name}") }
                                    DropdownMenu(expanded = menu == item.id, onDismissRequest = { menu = null }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                                        DropdownMenuItem(text = { Text("Remove from list") }, onClick = { menu = null; item.dismiss?.invoke() })
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // The sheet's actions sit at its foot, not under the last row; with none to offer, no foot.
            val finished = transfers.any { it.done && !it.failed }
            if (onlyRoom || retryable.size >= 2 || finished || running.size > 1) HorizontalDivider(color = alpine.divider)
            if (onlyRoom || retryable.size >= 2 || finished || running.size > 1) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onlyRoom) Button(onClick = makeRoom) { Text("Make room") }
                // One failed row already has its own Retry; the foot offers Retry failed from two (as iOS).
                else if (retryable.size >= 2) OutlinedButton(onClick = { retryable.forEach { it.retry?.invoke() } }) { Text("Retry failed") }
                if (finished) TextButton(onClick = model::clearFinished) { Text("Clear finished") }
                Spacer(Modifier.weight(1f))
                if (running.size > 1) TextButton(onClick = { cancelling = running }) { Text("Cancel all", color = alpine.danger) }
            }
        }
    }
    cancelling?.let { list ->
        AlertDialog(
            onDismissRequest = { cancelling = null },
            title = { Text(if (list.size == 1) "Cancel this transfer?" else "Cancel ${list.size} transfers?") },
            text = { Text("What is still on its way stops and isn’t kept. What already finished stays where it is.") },
            confirmButton = { TextButton(onClick = { list.forEach { it.cancel?.invoke() }; cancelling = null }) { Text(if (list.size == 1) "Cancel it" else "Cancel them all", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { cancelling = null }) { Text("Keep going") } },
        )
    }
}

/*
 * Not enough room, when an upload doesn't fit: empty the trash or remove earlier versions,
 * here, then the refused uploads go again. No way to the web's plans (store payment rules).
 */
@Composable
private fun StorageFullSheet(model: DriveViewModel, state: DriveState, waiting: List<TransferItem>, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { model.refreshStorage(); model.refreshAccount() }
    val trash = state.storage?.trashBytes ?: 0L
    val versions = state.storage?.supersededBytes ?: 0L
    val free = state.allowance?.let { formatSpace(maxOf(0L, it.quotaBytes - it.usedBytes)) } ?: "little room"
    val what = when (waiting.size) { 0 -> "This upload doesn’t fit"; 1 -> "“${waiting[0].name}” doesn’t fit"; else -> "These ${waiting.size} files don’t fit" }
    // Space freed: what didn't fit goes again.
    val retry = { waiting.forEach { it.retry?.invoke() }; dismiss() }
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S4)) {
            Text("Not enough room", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            Text("$what, and $free is free. Trash and earlier versions count until they’re removed.", style = MaterialTheme.typography.bodyMedium,
                color = alpine.inkMuted, modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = AlpineSpace.S3))
            if (trash > 0) RoomOption(Icons.Outlined.Delete, "Empty trash", if (busy == "trash") "Emptying…" else "Frees ${formatSpace(trash)}", enabled = busy == null) {
                busy = "trash"
                scope.launch { model.emptyTrash().join(); model.refreshAccount().join(); busy = null; retry() }
            }
            if (versions > 0) RoomOption(Icons.Outlined.History, "Remove earlier versions", if (busy == "versions") "Removing…" else "Frees ${formatSpace(versions)}", enabled = busy == null) {
                busy = "versions"
                scope.launch { model.discardEarlierVersions(); model.refreshAccount().join(); busy = null; retry() }
            }
            if (trash == 0L && versions == 0L && state.storage != null) Text("Nothing in the trash or earlier versions to remove. Move files you don’t need to the Trash first, then empty it.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = 24.dp, vertical = AlpineSpace.S2))
            TextButton(onClick = dismiss, modifier = Modifier.align(Alignment.End).padding(end = 16.dp)) { Text("Not now") }
        }
    }
}

@Composable
private fun RoomOption(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String, enabled: Boolean, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = alpine.ink)
        Column(Modifier.padding(start = AlpineSpace.S4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
    }
}
