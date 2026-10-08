package com.hushos.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.LibraryAdd
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.app.data.SharedByMe
import com.hushos.app.data.Vault
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch
import java.time.Instant

private fun first(name: String, email: String) = name.trim().split(Regex("\\s+")).firstOrNull { it.isNotEmpty() } ?: email.substringBefore('@')

/* What this account shared out, grouped as the Shared tab shows it: per item for people, per link for links. */
private data class Outgoing(val item: Opened?, val name: String, val shares: List<SharedByMe>, val link: SharedByMe?)

/*
 * Shared, in two halves. With me: what others handed this account, each row
 * saying who and what you can do, with Open, Save a copy and Report in its ⋮
 * sheet, and a field to open a HushOS link. By me: what this account handed out,
 * to people and by link, where Stop sharing and Turn off link ask once.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun SharedScreen(model: DriveViewModel, state: DriveState) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // The shared folder open, saved by id so it comes back after a rotation or a restart.
    var openedId by rememberSaveable { mutableStateOf<String?>(null) }
    val opened = openedId?.let { id -> state.shares?.firstNotNullOfOrNull { it.root?.takeIf { root -> root.id == id } } ?: model.item(id) }
    var linkText by rememberSaveable { mutableStateOf("") }
    var people by remember { mutableStateOf(false) }
    var byMe by rememberSaveable { mutableStateOf(false) }
    var mine by remember { mutableStateOf<List<SharedByMe>?>(null) }
    var mineFailed by remember { mutableStateOf(false) }
    var received by remember { mutableStateOf<Vault.ShareMount?>(null) }
    var reporting by remember { mutableStateOf<Vault.ShareMount?>(null) }
    var outgoing by remember { mutableStateOf<Outgoing?>(null) }
    var stopping by remember { mutableStateOf<Outgoing?>(null) }
    var sharing by remember { mutableStateOf<Opened?>(null) }
    var sending by remember { mutableStateOf<Opened?>(null) }
    var reload by remember { mutableStateOf(0) }
    suspend fun loadMine() { val rows = model.sharedByMe(); mineFailed = rows == null; if (rows != null) mine = rows }
    LaunchedEffect(byMe, reload) { if (byMe) loadMine() }
    // A link opened from elsewhere (retyped whole on a link that was cut short).
    LaunchedEffect(state.request) {
        val request = state.request ?: return@LaunchedEffect
        if (request.startsWith("link:")) { model.showLink(request.removePrefix("link:")); model.clearRequest() }
        // /app/shared?view=by-me: the By me side, at the top of the tab.
        if (request.startsWith("shared:")) { byMe = request == "shared:true"; model.closeLink(); openedId = null; model.clearRequest() }
    }
    model.link?.let { session ->
        LinkBrowser(model, state, session) { model.closeLink() }
        return
    }
    openedId?.let { id ->
        // A shared folder gets the full Files screen: search, select, paste, add, all in the sharer's drive.
        val root = opened
        if (root != null) BrowseScreen(model, state, start = root, onLeave = { openedId = null })
        else {
            // After a restart the shares are listed again before the folder can be found.
            LaunchedEffect(id) { if (state.shares == null) model.refreshShares() }
            LaunchedEffect(state.shares) { if (state.shares != null && opened == null && model.find(id) == null) openedId = null }
            OpeningScreen()
        }
        return
    }
    LaunchedEffect(Unit) { model.refreshShares() }
    // The top folder reads as Files, as everywhere else in the app.
    fun nameOf(item: Opened?) = when { item == null -> "Item outside this workspace"; item.id == state.rootId -> "Files"; else -> item.name }
    fun open(item: Opened) {
        if (item.isFolder) openedId = item.id else scope.launch { model.download(item)?.let { openWith(context, it, mimeOf(item), model, item.name) } }
    }
    Scaffold(contentWindowInsets = WindowInsets(0), containerColor = alpine.ground, topBar = {
        DestinationBar("Shared") {
            TextButton(onClick = { people = true }) {
                Icon(Icons.Outlined.Group, null, modifier = Modifier.size(20.dp)); Spacer(Modifier.size(AlpineSpace.S2)); Text("People")
            }
        }
    }) { padding ->
        Column(Modifier.padding(padding)) {
            if (state.unreachable) OfflineCapsule()
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
                SegmentedButton(selected = !byMe, onClick = { byMe = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("With me") }
                SegmentedButton(selected = byMe, onClick = { byMe = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("By me") }
            }
            PullToRefreshBox(
                isRefreshing = "shares" in state.loading && state.shares != null,
                onRefresh = { if (byMe) scope.launch { loadMine() } else model.refreshShares() },
                modifier = Modifier.weight(1f),
            ) {
                LazyColumn(Modifier.fillMaxSize()) {
                    if (!byMe) {
                        item(key = "open-link") {
                            Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    value = linkText, onValueChange = { linkText = it }, singleLine = true, label = { Text("Paste a HushOS link") },
                                    leadingIcon = { Icon(Icons.Outlined.ContentPaste, null) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                                    modifier = Modifier.weight(1f),
                                )
                                FilledTonalButton(enabled = linkText.contains("/s/"), onClick = { model.showLink(linkText.trim()) }, modifier = Modifier.padding(start = AlpineSpace.S2)) { Text("Open") }
                            }
                        }
                        val shares = state.shares
                        when {
                            shares == null && state.sharesFailed -> item(key = "error") {
                                EmptyState("Couldn’t load what’s shared", "Check your connection and try again.", Icons.Outlined.WarningAmber, danger = true, modifier = Modifier.padding(top = 64.dp)) {
                                    Button(onClick = { model.refreshShares() }) { Text("Try again") }
                                }
                            }
                            shares == null -> item(key = "loading") { SkeletonRows(4) }
                            shares.isEmpty() -> item(key = "empty") {
                                EmptyState("Nothing shared with you yet", "When someone shares a folder or file with you, it shows up here.", Icons.Outlined.Group, modifier = Modifier.padding(top = 64.dp))
                            }
                        }
                        items(shares.orEmpty(), key = { it.share.id }) { mount -> ReceivedRow(model, state, mount, onOpen = { mount.root?.let { open(it) } }, onMore = { received = mount }) }
                    } else {
                        val rows = mine
                        val withPeople = rows.orEmpty().filter { it.share != null }.groupBy { it.node.id }
                            .map { (_, list) -> Outgoing(list.first().item, nameOf(list.first().item), list, null) }
                        val links = rows.orEmpty().filter { it.link != null }.map { Outgoing(it.item, nameOf(it.item), emptyList(), it) }
                        when {
                            rows == null && mineFailed -> item(key = "error") {
                                EmptyState("Couldn’t load what’s shared", "Check your connection and try again.", Icons.Outlined.WarningAmber, danger = true, modifier = Modifier.padding(top = 64.dp)) {
                                    Button(onClick = { reload++ }) { Text("Try again") }
                                }
                            }
                            rows == null -> item(key = "loading") { SkeletonRows(4) }
                            rows.isEmpty() -> item(key = "empty") {
                                EmptyState("You haven’t shared anything yet", "Choose Share on any folder or file to let someone open it.", Icons.Outlined.Group, modifier = Modifier.padding(top = 64.dp))
                            }
                            else -> {
                                item(key = "people") { Subheader("With people") }
                                if (withPeople.isEmpty()) item(key = "no-people") { Text("Nobody yet", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) }
                                items(withPeople, key = { "p:" + it.shares.first().node.id }) { row ->
                                    OutgoingRow(model, state, row, onOpen = { row.item?.let { sharing = it } }, onMore = { outgoing = row })
                                }
                                item(key = "links") { Subheader("Links") }
                                if (links.isEmpty()) item(key = "no-links") { Text("No links on", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) }
                                items(links, key = { "l:" + it.link!!.id }) { row -> OutgoingRow(model, state, row, onOpen = { row.item?.let { sharing = it } }, onMore = { outgoing = row }) }
                            }
                        }
                    }
                }
            }
        }
    }
    received?.let { mount ->
        val root = mount.root
        val from = first(mount.share.granterName, mount.share.granterEmail)
        Sheet(onDismissRequest = { received = null }) {
            Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S4)) {
                if (root != null) ItemHeader(model, state, root, subtitle = "From $from · ${if (mount.share.role == "editor") "can edit" else "can view"}")
                HorizontalDivider(color = alpine.divider)
                if (root != null) {
                    SheetRow("Open", Icons.Outlined.FolderOpen) { received = null; open(root) }
                    if (!root.isFolder) SheetRow("Send a copy", Icons.AutoMirrored.Outlined.Send) { received = null; sending = root }
                    // On this phone, as for this drive's own: a shared folder is kept current through its share.
                    val kept = if (root.isFolder) state.keptFolders.any { it.id == root.id } else state.offline.any { it.id == root.id }
                    if (kept) SheetRow("Remove from this phone", Icons.Outlined.RemoveCircleOutline) {
                        received = null; model.setKeptDownloaded(root, false); model.notify("Removed “${root.name}” from this phone. It’s still in HushOS.")
                    } else SheetRow("Keep on this phone", Icons.Outlined.DownloadForOffline) { received = null; model.setKeptDownloaded(root, true) }
                    SheetRow("Save a copy to my files", Icons.Outlined.LibraryAdd) { received = null; model.saveCopy(listOf(root)) }
                    HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4), color = alpine.divider)
                    SheetRow("Report", Icons.Outlined.Flag) { received = null; reporting = mount }
                }
            }
        }
    }
    reporting?.let { mount ->
        mount.root?.let { item ->
            ReportSheet(item, model.reportsGoTo(state), dismiss = { reporting = null }, from = first(mount.share.granterName, mount.share.granterEmail)) { category, reason, email ->
                model.report(item, category, reason, email)
            }
        }
    }
    outgoing?.let { row ->
        val link = row.link
        Sheet(onDismissRequest = { outgoing = null }) {
            Column(Modifier.fillMaxWidth().padding(bottom = AlpineSpace.S4)) {
                row.item?.let { ItemHeader(model, state, it, subtitle = whoOf(row), open = link != null) }
                HorizontalDivider(color = alpine.divider)
                if (link?.link != null && row.item != null) SheetRow("Copy link", Icons.Outlined.Link) {
                    outgoing = null
                    scope.launch {
                        val url = model.linkUrl(link.link, row.item)
                        if (url != null) {
                            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("HushOS link", url))
                            model.notify("Link copied. Anyone with it can view “${row.name}”.")
                        } else model.notify("This link was made before links could be shown again. Turn it off and make a new one.")
                    }
                }
                if (row.item != null) SheetRow("Who can open", Icons.Outlined.Group) { outgoing = null; sharing = row.item }
                HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4), color = alpine.divider)
                if (row.item != null) SheetRow(if (link != null) "Turn off link" else "Stop sharing", if (link != null) Icons.Outlined.LinkOff else Icons.Outlined.PersonRemove, danger = true) {
                    outgoing = null; stopping = row
                }
            }
        }
    }
    stopping?.let { row ->
        val item = row.item ?: return@let
        val who = whoNames(row)
        AlertDialog(
            onDismissRequest = { stopping = null },
            title = { Text(if (row.link != null) "Turn off this link?" else "Stop sharing “${row.name}”?") },
            text = { Text(if (row.link != null) "Anyone who has it can’t open “${row.name}” any more. Other links keep working." else "$who can’t open it in HushOS any more. Copies they already downloaded stay with them. You can share it again later.") },
            confirmButton = { TextButton(onClick = {
                stopping = null
                scope.launch {
                    val current = model.item(item.id) ?: item
                    val ok = if (row.link != null) model.revokeLink(row.link.link!!, current) else row.shares.all { it.share?.let { share -> model.revokeShare(share, model.item(item.id) ?: current) } ?: true }
                    model.notify(when {
                        !ok && row.link != null -> "Couldn’t turn the link off. Check your connection and try again."
                        !ok -> "Couldn’t stop sharing. Check your connection and try again."
                        row.link != null -> "Link turned off"
                        else -> "$who can’t open “${row.name}” any more"
                    })
                    reload++; model.refreshAccess()
                }
            }) { Text(if (row.link != null) "Turn off link" else "Stop sharing", color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { stopping = null }) { Text("Cancel") } },
        )
    }
    if (people) PeopleSheet(model, state) { people = false }
    sending?.let { item -> SendCopy(model, state, listOf(item)) { sending = null } }
    sharing?.let { item -> ShareSheet(model, state, item) { sharing = null; reload++; model.refreshAccess() } }
}

private fun whoNames(row: Outgoing): String = names(row.shares.mapNotNull { it.share }.map { it.granteeName.ifEmpty { it.granteeEmail } })

/* "Sam, Priya and Erik · can edit · since 14 Aug", or "Anyone with the link · opened 3 times". */
private fun whoOf(row: Outgoing): String {
    row.link?.link?.let { return "Anyone with the link · " + describeLink(it).replaceFirstChar { c -> c.lowercase() } }
    val shares = row.shares.mapNotNull { it.share }
    val roles = shares.map { it.role }.distinct()
    val role = when (roles.singleOrNull()) { "editor" -> "can edit"; "viewer" -> "can view"; else -> "some can edit" }
    val since = shares.mapNotNull { runCatching { Instant.parse(it.createdAt).toEpochMilli() }.getOrNull() }.minOrNull()?.let { whenText(it) }
    return listOfNotNull(names(shares.map { first(it.granteeName, it.granteeEmail) }), role, since?.let { "since " + it.replaceFirstChar { c -> c.lowercase() } }).joinToString(" · ")
}

/* Something someone shared with this account: its mark, its name, who and what you can do. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ReceivedRow(model: DriveViewModel, state: DriveState, mount: Vault.ShareMount, onOpen: () -> Unit, onMore: () -> Unit) {
    val alpine = Alpine.colors
    val root = mount.root
    val from = first(mount.share.granterName, mount.share.granterEmail)
    if (root == null) {
        // A share whose name can't be read: who it came from, and what to do.
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(36.dp).background(alpine.dangerSoft, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.WarningAmber, null, tint = alpine.danger, modifier = Modifier.size(20.dp)) }
            Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                Text("Shared by $from", style = MaterialTheme.typography.bodyLarge)
                Text("Couldn’t open this. Ask $from to share it again.", style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
            }
        }
        return
    }
    LaunchedEffect(root.id) { model.thumbnail(root) }
    val thumbnail = state.thumbnails[root.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).combinedClickable(onClick = onOpen, onLongClick = onMore).padding(start = AlpineSpace.S4, end = AlpineSpace.S1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Mark(root, bitmap) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(root.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("From $from · ${if (mount.share.role == "editor") "can edit" else "can view"}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1)
        }
        if (state.opening[root.id] != null) androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.padding(horizontal = 13.dp).size(22.dp), strokeWidth = 2.5.dp)
        else IconButton(onClick = onMore) { Icon(Icons.Outlined.MoreVert, "More for ${root.name}", tint = alpine.inkMuted) }
    }
}

/* Something this account shared: who has it, or the link and how it's been used. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun OutgoingRow(model: DriveViewModel, state: DriveState, row: Outgoing, onOpen: () -> Unit, onMore: () -> Unit) {
    val alpine = Alpine.colors
    val item = row.item
    item?.let { LaunchedEffect(it.id) { model.thumbnail(it) } }
    val thumbnail = item?.let { state.thumbnails[it.id] }
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).combinedClickable(enabled = item != null, onClick = onOpen, onLongClick = onMore).padding(start = AlpineSpace.S4, end = AlpineSpace.S1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { if (item != null) Mark(item, bitmap) else Icon(Icons.Outlined.Link, null, tint = alpine.inkMuted) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(row.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            AccessText(whoOf(row), linked = row.link != null)
        }
        if (item != null) IconButton(onClick = onMore) { Icon(Icons.Outlined.MoreVert, "More for ${row.name}", tint = alpine.inkMuted) }
    }
}
