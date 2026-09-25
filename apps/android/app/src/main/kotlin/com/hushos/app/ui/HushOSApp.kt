package com.hushos.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
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

/* The gate, then Home, Files, Shared and Account as bottom tabs, as the cloud drives lay themselves out on a phone. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSApp(model: DriveViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    when (state.gate) {
        Gate.CHECKING -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        Gate.SIGNED_OUT -> SignInScreen(model, state)
        Gate.SIGNED_IN -> Column(Modifier.fillMaxSize()) {
            // While the app is on screen the lists follow the server, as the web's feed does; in the background nothing polls.
            val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
            androidx.compose.runtime.LaunchedEffect(lifecycle) {
                lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.RESUMED) {
                    while (true) { model.liveSync(); kotlinx.coroutines.delay(10_000) }
                }
            }
            if (state.unreachable) OfflineBanner()
            // The banner took the status bar's height; the screens below must not pad for it again.
            Box(if (state.unreachable) Modifier.weight(1f).consumeWindowInsets(WindowInsets.statusBars).padding(top = 4.dp) else Modifier.weight(1f)) { Main(model, state) }
        }
    }
    state.error?.let { message ->
        AlertDialog(
            onDismissRequest = model::clearError,
            confirmButton = { TextButton(onClick = model::clearError) { Text("OK") } },
            title = { Text("Something went wrong") },
            text = { Text(message) },
        )
    }
}

private enum class Tab(val label: String) { HOME("Home"), FILES("Files"), SHARED("Shared"), ACCOUNT("Account") }

@Composable
private fun Main(model: DriveViewModel, state: DriveState) {
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    // Here rather than in the panel, which leaves the screen while the add menu is open.
    var transfersCollapsed by rememberSaveable { mutableStateOf(false) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (entry in Tab.entries) {
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tab = entry },
                        icon = {
                            Icon(
                                when (entry) {
                                    Tab.HOME -> Icons.Outlined.Home
                                    Tab.FILES -> Icons.Outlined.Folder
                                    Tab.SHARED -> Icons.Outlined.Group
                                    Tab.ACCOUNT -> Icons.Outlined.AccountCircle
                                },
                                contentDescription = entry.label,
                            )
                        },
                        label = { Text(entry.label) },
                    )
                }
            }
        },
        snackbarHost = {
            Column {
                state.notice?.let { notice ->
                    Snackbar(
                        // Above the add button, which sits over this corner on Files and would cover Undo.
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = if (state.transfers.isEmpty() && state.queued.isEmpty()) 76.dp else 0.dp),
                        action = notice.undo?.let { undo -> { TextButton(onClick = { model.dismissNotice(); undo() }, colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.inversePrimary)) { Text("Undo") } } },
                    ) { Text(notice.text, maxLines = 2) }
                }
                val all = state.queued + state.transfers
                // A new batch after the panel has closed starts unfolded, as the web's does.
                LaunchedEffect(all.isEmpty()) { if (all.isEmpty()) transfersCollapsed = false }
                // Above the add button, which sits over this corner on Files.
                if (all.isNotEmpty() && !state.addMenuOpen) Box(Modifier.padding(bottom = 72.dp)) { TransferPanel(all, offline = state.unreachable, close = model::closeTransfers, collapsed = transfersCollapsed, toggle = { transfersCollapsed = !transfersCollapsed }) }
            }
        },
    ) { padding ->
        Box(Modifier.padding(bottom = padding.calculateBottomPadding())) {
            when (tab) {
                Tab.HOME -> HomeScreen(model, state)
                Tab.FILES -> BrowseScreen(model, state)
                Tab.SHARED -> SharedScreen(model, state)
                Tab.ACCOUNT -> AccountScreen(model, state)
            }
        }
    }
}

/* A quiet line at the top while the server is out of reach; kept files still open. */
@Composable
private fun OfflineBanner() {
    // A little room below, so the screen under it never starts flush against the line.
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.fillMaxWidth().statusBarsPadding()) {
        Text("You're offline. Showing what's on this phone.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

/*
 * Every transfer with its own bar, the way the web's panel shows them: name, progress, and how it ended.
 * Failures come first, since they are why the panel is still up; past about four rows the list scrolls.
 * Once nothing is running, the header's cross closes it. Folded, it keeps the header and one bar for the lot.
 * A failed upload that kept its file offers a retry, and the header retries them all at once.
 */
@Composable
private fun TransferPanel(transfers: List<TransferItem>, offline: Boolean, close: () -> Unit, collapsed: Boolean, toggle: () -> Unit) {
    val running = transfers.filter { !it.done }
    val headline = when {
        // How it ended, in words, as the web's panel says it: a bare "Done" read as a button.
        running.isEmpty() -> if (transfers.any { it.failed }) "Some transfers failed" else if (transfers.size == 1) "1 transfer finished" else "${transfers.size} transfers finished"
        running.all { it.waiting } -> if (offline) "Waiting for a network" else "Queued"
        running.all { it.kind == "upload" } -> if (running.size == 1) "Uploading" else "Uploading ${running.size} files"
        running.size == 1 -> when (running[0].kind) { "copy" -> "Copying"; "keep" -> "Keeping downloaded"; "rotate" -> "Rotating keys"; else -> "Downloading" }
        else -> "${running.size} transfers"
    }
    Surface(tonalElevation = 3.dp, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(headline, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (transfers.size > 1) Text("${transfers.count { it.done }} of ${transfers.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val retries = transfers.mapNotNull { it.retry }
                if (running.isEmpty() && retries.size > 1) IconButton(onClick = { retries.forEach { it() } }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Outlined.Refresh, "Retry all failed", modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = toggle, modifier = Modifier.size(32.dp)) {
                    Icon(if (collapsed) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (collapsed) "Expand transfers" else "Collapse transfers", modifier = Modifier.size(20.dp))
                }
                if (running.isEmpty()) IconButton(onClick = close, modifier = Modifier.size(32.dp)) { Icon(Icons.Outlined.Close, "Close transfers", modifier = Modifier.size(18.dp)) }
            }
            val moving = running.filter { !it.waiting && it.kind != "rotate" }
            if (collapsed && moving.isNotEmpty()) LinearProgressIndicator(progress = { moving.map { it.fraction }.average().toFloat() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            if (!collapsed) Column(Modifier.heightIn(max = 232.dp).verticalScroll(rememberScrollState())) {
                for (item in transfers.sortedByDescending { it.failed }) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                        Icon(
                            when { item.failed -> Icons.Outlined.ErrorOutline; item.done -> Icons.Outlined.CheckCircle; item.kind == "upload" -> Icons.Outlined.CloudUpload; item.kind == "copy" -> Icons.Outlined.ContentCopy; item.kind == "rotate" -> Icons.Outlined.Key; else -> Icons.Outlined.CloudDownload },
                            null,
                            tint = if (item.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        )
                        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            Text(item.name, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                            if (!item.done && !item.waiting && item.kind != "rotate") LinearProgressIndicator(progress = { item.fraction }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                            // The reason, in the server's words where it refused: what to do next is in it.
                            item.message?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 3, modifier = Modifier.padding(top = 2.dp)) }
                        }
                        // A finished row says how it ended with its icon (and a failure with its reason); only what is still moving gets words here.
                        if (!item.done) Text(if (item.waiting) (if (offline) "Waiting" else "Queued") else if (item.kind == "rotate") "" else "${(item.fraction * 100).toInt()}%",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        item.cancel?.let { cancel ->
                            IconButton(onClick = cancel, modifier = Modifier.size(32.dp)) { Icon(Icons.Outlined.Close, "Cancel ${item.name}", modifier = Modifier.size(18.dp)) }
                        }
                        item.retry?.let { retry ->
                            IconButton(onClick = retry, modifier = Modifier.size(32.dp)) { Icon(Icons.Outlined.Refresh, "Retry ${item.name}", modifier = Modifier.size(18.dp)) }
                        }
                        item.dismiss?.let { dismiss ->
                            IconButton(onClick = dismiss, modifier = Modifier.size(32.dp)) { Icon(Icons.Outlined.Close, "Dismiss ${item.name}", modifier = Modifier.size(18.dp)) }
                        }
                    }
                }
            }
        }
    }
}
