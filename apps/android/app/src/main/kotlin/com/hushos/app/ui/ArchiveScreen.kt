package com.hushos.app.ui

import android.app.ActivityManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.hushos.app.data.ArchiveTree
import com.hushos.app.data.ArchiveWords
import com.hushos.app.data.MarkdownDocument
import com.hushos.app.data.OpenArchive
import com.hushos.app.data.Opened
import com.hushos.app.data.ToolFailed
import com.hushos.core.ArchiveEntry
import com.hushos.core.ArchiveException
import com.hushos.core.EntrySink
import com.hushos.core.FetchException
import com.hushos.core.toolFailedMessage
import com.hushos.core.zipEntryAsksFirst
import com.hushos.core.zipEntryPreviewLimits
import com.hushos.tokens.AlpineSpace
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/*
 * A zip opened in the app (docs/file-tools-design.md, section 1 (a)): the list of what is inside
 * it, read from its directory alone, with a breadcrumb over its folders, each file's size and date,
 * and each entry previewed from memory or downloaded on its own. Nothing of an entry is written to
 * a file of the app's: previews are bytes held while they show, and a download streams into the
 * file the person picked. The web's archive view and iOS's ArchiveView say and do the same.
 */

/* The person's words for what a call met; `entry` for an item's own call. */
internal fun archiveFailure(error: Throwable, entry: Boolean = false): String = when (error) {
    is ArchiveException.Refused -> ArchiveWords.refusal(error.code, entry)
    // The read underneath (the network, the kept copy, a close) in its own words.
    is ArchiveException.Failed -> error.reason.ifBlank { toolFailedMessage() }
    is ToolFailed -> error.message ?: toolFailedMessage()
    is com.hushos.app.data.ArchiveSessionRefused -> error.message ?: toolFailedMessage()
    // A family's file whose family folder was let go of meanwhile: the family's words.
    is com.hushos.app.data.FamilyFailure -> error.message ?: toolFailedMessage()
    else -> toolFailedMessage()
}

@Composable
fun ArchiveScreen(model: DriveViewModel, browse: ArchiveBrowse, close: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val state by model.state.collectAsState()
    val item = browse.subject
    val current = browse.archive
    val tree = browse.tree
    var sending by remember(item.id) { mutableStateOf(false) }

    // Downloads stream into the file the person picks (SAF): no copy of the entry is made anywhere
    // else. The entry waited for lives in the model, so a rotation while the dialog is up loses nothing.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val entry = browse.waitingFor
        browse.waitingFor = null
        if (uri == null) return@rememberLauncherForActivityResult
        if (entry == null) { browse.discardIfMade(context.contentResolver, uri); return@rememberLauncherForActivityResult }
        browse.startDownload(entry, context.contentResolver, uri) { model.notify(ArchiveWords.DOWNLOADED) }
    }
    fun pick(entry: ArchiveEntry) {
        browse.waitingFor = entry
        // Under the name made safe by the core: no bidi override can make "…exe" read as "…txt".
        picker.launch(entry.saveName)
    }
    fun download(entry: ArchiveEntry) {
        // Its password first, then this download goes on (browse.unlockedFor).
        if (entry.lock != "none" && !browse.unlocked) { browse.downloadOnceUnlocked(entry); return }
        if (zipEntryAsksFirst(entry.size, entry.packed)) { browse.asking = entry; return }
        pick(entry)
    }

    fun back() {
        when {
            browse.opened != null -> browse.show(null)
            browse.path.isNotEmpty() -> browse.path = browse.path.dropLast(1)
            else -> close()
        }
    }

    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = ::back)
        Scaffold(containerColor = alpine.ground, topBar = { DestinationBar(item.name, onBack = ::back) }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                val failure = browse.failure
                when {
                    failure != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        EmptyState(ArchiveWords.CANT_SHOW, failure) {
                            Button(onClick = browse::load) { Text(ArchiveWords.TRY_AGAIN) }
                        }
                    }
                    current == null || tree == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        CircularProgressIndicator(color = alpine.primary, modifier = Modifier.padding(top = 48.dp))
                    }
                    else -> {
                        val path = browse.path
                        val entry = browse.opened
                        // At the top the bar already names the archive: the trail shows only inside it.
                        if (path.isNotEmpty() || entry != null) {
                            Crumbs(item.name, path.map(tree::name), entry) { depth -> browse.show(null); browse.path = path.take(depth) }
                            HorizontalDivider(color = alpine.rule)
                        }
                        Box(Modifier.weight(1f)) {
                            if (entry != null) EntryPane(
                                current, entry, browse.unlocked, reprompt = entry.index in browse.reprompt,
                                doubted = browse.doubted,
                                downloadWaiting = browse.downloadAfterPassword == entry.index,
                                onAskToDownload = { browse.downloadOnceUnlocked(entry) },
                                // A Download that waited on this password goes on: its confirmation, then the Save dialog.
                                onUnlocked = { if (browse.unlockedFor(entry)) download(entry) },
                                onWrongPassword = { if (entry.index !in browse.reprompt) browse.reprompt.add(entry.index) },
                                onPasswordLost = browse::passwordLost,
                                onDownload = { download(entry) },
                                onDownloadArchive = { sending = true },
                                failed = browse::failed,
                            )
                            else EntryList(tree.rows(path.lastOrNull() ?: 0), browse.unlocked, browse.hidden, onFolder = { browse.path = path + it }, onOpen = browse::show, onDownload = ::download)
                        }
                        for (record in browse.downloads) DownloadBar(record) { browse.stop(record) }
                    }
                }
            }
        }
        browse.asking?.let { entry ->
            AlertDialog(
                onDismissRequest = { browse.asking = null },
                title = { Text(ArchiveWords.asksFirst(entry.size.toLong(), entry.packed.toLong())) },
                confirmButton = { TextButton(onClick = { browse.asking = null; pick(entry) }) { Text(ArchiveWords.DOWNLOAD) } },
                dismissButton = { TextButton(onClick = { browse.asking = null }) { Text(ArchiveWords.CANCEL) } },
            )
        }
        // The archive itself, for an item HushOS can't open: the drive's own Send a copy.
        if (sending) {
            val row = item.item
            val kept = item.kept
            when {
                row != null -> SendCopy(model, state, listOf(row)) { sending = false }
                kept != null -> LaunchedEffect(kept) { model.sendKept(item.name, kept); sending = false }
                else -> LaunchedEffect(Unit) { sending = false }
            }
        }
    }
}

@Composable
private fun DownloadBar(record: EntryDownload, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val error by record.error
    val written by record.written
    Row(Modifier.fillMaxWidth().background(alpine.surface).heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
        Text(error ?: ArchiveWords.downloading(record.entry.name), style = MaterialTheme.typography.bodyMedium, color = if (error != null) alpine.danger else alpine.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (error == null && record.entry.size > 0uL) Text("${(written * 100 / record.entry.size.toLong()).coerceIn(0, 100)}%", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, if (error != null) "Dismiss" else ArchiveWords.STOP) }
    }
}

/* The archive's name, then each folder down to where you are: each one a step back up (`go` hears how many folders deep). */
@Composable
private fun Crumbs(name: String, path: List<String>, opened: ArchiveEntry?, go: (Int) -> Unit) {
    val alpine = Alpine.colors
    val steps = listOf(name) + path + listOfNotNull(opened?.name)
    // One line however deep, scrolled to its end as the path changes: the crumb shown is the last.
    val scroll = rememberScrollState()
    LaunchedEffect(steps) { scroll.scrollTo(scroll.maxValue) }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(scroll).heightIn(min = 48.dp).padding(horizontal = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        steps.forEachIndexed { index, step ->
            if (index > 0) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted, modifier = Modifier.size(18.dp))
            val last = index == steps.lastIndex
            Text(
                step,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (last) FontWeight.SemiBold else FontWeight.Normal,
                color = if (last) alpine.ink else alpine.inkMuted,
                maxLines = 1,
                modifier = Modifier
                    .then(if (last) Modifier else Modifier.clickable(role = Role.Button) { go(index) })
                    .heightIn(min = 48.dp).padding(horizontal = AlpineSpace.S2).wrapCenter(),
            )
        }
    }
}

private fun Modifier.wrapCenter() = this.then(Modifier.padding(vertical = 14.dp))

private fun rowLine(entry: ArchiveEntry, unlocked: Boolean): String = when {
    entry.link -> ArchiveWords.LINK
    entry.lock != "none" && !unlocked -> ArchiveWords.NEEDS_PASSWORD
    else -> listOfNotNull(formatBytes(entry.size.toLong()), whenText(ArchiveTree.modifiedMillis(entry))).joinToString(" · ")
}

@Composable
private fun EntryList(
    rows: List<ArchiveTree.Row>,
    unlocked: Boolean,
    hidden: Int,
    onFolder: (Int) -> Unit,
    onOpen: (ArchiveEntry) -> Unit,
    onDownload: (ArchiveEntry) -> Unit,
) {
    val alpine = Alpine.colors
    if (rows.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(ArchiveWords.EMPTY, color = alpine.inkMuted, textAlign = TextAlign.Center) }
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(rows, key = { row -> when (row) { is ArchiveTree.Row.Folder -> "d:${row.name}"; is ArchiveTree.Row.File -> "f:${row.entry.index}" } }) { row ->
            when (row) {
                is ArchiveTree.Row.Folder -> EntryRow(row.name, ArchiveWords.items(row.count), folder = true, onClick = { onFolder(row.id) })
                is ArchiveTree.Row.File -> {
                    val entry = row.entry
                    val locked = entry.lock != "none" && !unlocked
                    EntryRow(
                        row.name, rowLine(entry, unlocked), locked = locked,
                        onClick = if (entry.link) null else ({ onOpen(entry) }),
                        onDownload = if (!entry.link && entry.support == "ok") ({ onDownload(entry) }) else null,
                    )
                }
            }
        }
        if (hidden > 0) item {
            Text(
                ArchiveWords.hidden(hidden), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(AlpineSpace.S4),
            )
        }
    }
}

/* A row as the drive's (NodeRow): 56dp, a 36dp mark, the name, and a muted line under it. */
@Composable
private fun EntryRow(name: String, line: String, folder: Boolean = false, locked: Boolean = false, onClick: (() -> Unit)?, onDownload: (() -> Unit)? = null) {
    val alpine = Alpine.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(start = AlpineSpace.S4, end = if (onDownload != null) AlpineSpace.S1 else AlpineSpace.S4),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { if (folder) FolderMark() else PageMark(name) }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (locked) Icon(Icons.Outlined.Lock, null, tint = alpine.inkMuted, modifier = Modifier.size(14.dp).padding(end = 2.dp))
                Text(line, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (onDownload != null) IconButton(onClick = onDownload) { Icon(Icons.Outlined.Download, "${ArchiveWords.DOWNLOAD} $name", tint = alpine.inkMuted) }
    }
}

/* One card in the middle: what happened, a line, and the way forward. */
@Composable
private fun Notice(title: String, text: String? = null, icon: (@Composable () -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    val alpine = Alpine.colors
    Box(Modifier.fillMaxSize().padding(AlpineSpace.S4), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().readableWidth(420.dp).background(alpine.surface, RoundedCornerShape(24.dp)).padding(AlpineSpace.S6),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
        ) {
            icon?.invoke()
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, color = alpine.ink, modifier = Modifier.semantics { heading() })
            text?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted, textAlign = TextAlign.Center) }
            actions()
        }
    }
}

/* The device's memory, for the large-file card's limits. */
private fun deviceMemory(context: android.content.Context): Long {
    val info = ActivityManager.MemoryInfo()
    context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(info)
    return info.totalMem
}

@Composable
private fun EntryPane(
    archive: OpenArchive,
    entry: ArchiveEntry,
    unlocked: Boolean,
    reprompt: Boolean,
    /* The password held was let go of, maybe wrong: the card says so. */
    doubted: Boolean,
    /* A Download waits on this item's password: its card shows at once, and the download goes on after. */
    downloadWaiting: Boolean,
    onAskToDownload: () -> Unit,
    onUnlocked: () -> Unit,
    onWrongPassword: () -> Unit,
    onPasswordLost: (Boolean) -> Unit,
    onDownload: () -> Unit,
    onDownloadArchive: () -> Unit,
    failed: (Throwable, Boolean) -> String,
) {
    val note = if (doubted) ArchiveWords.PASSWORD_UNPROVEN else null
    val alpine = Alpine.colors
    val context = LocalContext.current
    val name = entry.name
    val kind = remember(name) { ArchiveTree.previewKind(name) }
    val limits = remember(kind) { zipEntryPreviewLimits(kind, deviceMemory(context).toULong()) }
    var continued by remember(entry.index) { mutableStateOf(false) }
    // Each password typed for this item opens it afresh.
    var attempt by remember(entry.index) { mutableStateOf(0) }
    val size = entry.size.toLong()
    val locked = (entry.lock != "none" && !unlocked) || reprompt
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
            Text(listOfNotNull(formatBytes(size), whenText(ArchiveTree.modifiedMillis(entry))).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.weight(1f))
            if (entry.support == "ok" && !locked) OutlinedButton(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) }
        }
        HorizontalDivider(color = alpine.rule)
        Box(Modifier.weight(1f)) {
            when {
                // What can't be read at all says so first: a password would change nothing.
                entry.support == "method" -> Notice(name, ArchiveWords.METHOD) { Button(onClick = onDownloadArchive) { Text(ArchiveWords.DOWNLOAD_ARCHIVE) } }
                entry.support == "encryption" -> Notice(name, ArchiveWords.ENCRYPTION) { Button(onClick = onDownloadArchive) { Text(ArchiveWords.DOWNLOAD_ARCHIVE) } }
                // An archive inside is never previewed; downloading a locked one asks for its password first.
                entry.nested && (downloadWaiting || reprompt) && locked -> PasswordCard(archive, name, entry.index, note, failed) {
                    attempt++
                    onUnlocked()
                }
                entry.nested -> Notice(name, ArchiveWords.NESTED) { Button(onClick = { if (locked) onAskToDownload() else onDownload() }) { Text(ArchiveWords.DOWNLOAD) } }
                locked -> PasswordCard(archive, name, entry.index, note, failed) { attempt++; onUnlocked() }
                kind == "other" -> Notice(ArchiveWords.NO_PREVIEW, name) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
                kind == "pdf" && Build.VERSION.SDK_INT < Build.VERSION_CODES.R -> Notice(ArchiveWords.NO_PREVIEW, ArchiveWords.PDF_NEEDS_ANDROID_11) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
                // The large-file card: past the ceiling only Download; past the threshold, what opening costs and Continue.
                size.toULong() > limits.ceiling -> Notice(ArchiveWords.tooLarge(size), ArchiveWords.ELSEWHERE) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
                limits.threshold?.let { size.toULong() > it } == true && !continued -> Notice(ArchiveWords.large(size), ArchiveWords.COSTLY) {
                    Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                        OutlinedButton(onClick = { continued = true }) { Text(ArchiveWords.CONTINUE) }
                        Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) }
                    }
                }
                else -> EntryPreview(archive, entry, kind, limits.ceiling.toLong(), attempt, onWrongPassword, onPasswordLost, onDownload, failed)
            }
        }
    }
}

@Composable
private fun EntryPreview(archive: OpenArchive, entry: ArchiveEntry, kind: String, limit: Long, attempt: Int, onWrongPassword: () -> Unit, onPasswordLost: (Boolean) -> Unit, onDownload: () -> Unit, failed: (Throwable, Boolean) -> String) {
    val alpine = Alpine.colors
    var shown by remember(entry.index, attempt) { mutableStateOf<Shown>(Shown.Loading) }
    LaunchedEffect(entry.index, attempt) {
        shown = try {
            val bytes = archive.preview(entry.index, limit)
            // Decoded off the main thread: an image or a PDF's first pages, the text cut into blocks.
            withContext(Dispatchers.Default) { decode(kind, entry.name, bytes) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            // The item has a password of its own: asked for again, for this item.
            if (error is ArchiveException.Refused && error.code == "wrong-password") onWrongPassword()
            // No password held any more (the held one, maybe wrong, let go of): this item asks again.
            if (error is ArchiveException.Refused && (error.code == "password-unproven" || error.code == "password")) {
                onPasswordLost(error.code == "password-unproven")
            }
            Shown.Failed(failed(error, true))
        }
    }
    when (val now = shown) {
        Shown.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) { CircularProgressIndicator(color = alpine.primary, modifier = Modifier.padding(top = 48.dp)) }
        is Shown.Failed -> Notice(ArchiveWords.CANT_SHOW, now.message) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
        is Shown.Picture -> PictureView(now.image)
        is Shown.Pdf -> PdfView(now.document, onDownload)
        is Shown.Markdown -> LazyColumn(Modifier.fillMaxSize().readableWidth(720.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            itemsIndexed(now.blocks) { _, block -> SelectionContainer { MarkdownBlockView(block) } }
        }
        is Shown.Text -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
            items(now.pieces.size) { index ->
                SelectionContainer {
                    Text(now.pieces[index], style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = alpine.ink, modifier = Modifier.horizontalScroll(rememberScrollState()))
                }
            }
        }
        is Shown.Undecodable -> Notice(ArchiveWords.CANT_SHOW, ArchiveWords.ELSEWHERE) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
    }
}

/* The most of one block of text: 200 lines, and never more than this many characters. */
internal const val TEXT_BLOCK_LINES = 200
internal const val TEXT_BLOCK_CHARS = 16 * 1024

/*
 * Text in blocks bounded by lines and by size, so no one Text lays out a megabyte: a block ends at
 * 200 lines or 16,384 characters, and a single longer line is cut across blocks.
 */
internal fun textBlocks(text: String): List<String> {
    val blocks = ArrayList<String>()
    val block = StringBuilder()
    var lines = 0
    fun flush() {
        if (block.isNotEmpty() || lines > 0) blocks.add(block.toString())
        block.setLength(0)
        lines = 0
    }
    var at = 0
    while (at <= text.length) {
        val end = text.indexOf('\n', at).let { if (it < 0) text.length else it }
        var line = at
        // A line too long for what is left starts a block of its own: cut into this one, it would
        // run on from the line before with its line break lost.
        if (lines > 0 && end - line + 1 > TEXT_BLOCK_CHARS - block.length) flush()
        while (end - line > TEXT_BLOCK_CHARS - block.length) {
            var room = TEXT_BLOCK_CHARS - block.length
            // Never between a surrogate pair: half an emoji in each block would show as two broken ones.
            if (room > 1 && Character.isHighSurrogate(text[line + room - 1])) room--
            block.append(text, line, line + room)
            line += room
            flush()
        }
        if (lines > 0) block.append('\n')
        block.append(text, line, end)
        lines++
        if (lines >= TEXT_BLOCK_LINES || block.length >= TEXT_BLOCK_CHARS) flush()
        if (end == text.length) break
        at = end + 1
    }
    flush()
    return blocks
}

private sealed interface Shown {
    data object Loading : Shown
    data class Failed(val message: String) : Shown
    data class Picture(val image: androidx.compose.ui.graphics.ImageBitmap) : Shown
    data class Pdf(val document: PdfDocumentHolder) : Shown
    data class Markdown(val blocks: List<com.hushos.app.data.MdBlock>) : Shown
    data class Text(val pieces: List<String>) : Shown
    data object Undecodable : Shown
}

/* What the bytes show as, worked out off the main thread. */
private fun decode(kind: String, name: String, bytes: ByteArray): Shown = when (kind) {
    "image" -> runCatching {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { decoder, info, _ ->
            val longest = maxOf(info.size.width, info.size.height)
            if (longest > 4096) {
                val scale = 4096f / longest
                decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }.asImageBitmap()
    }.map { Shown.Picture(it) as Shown }.getOrDefault(Shown.Undecodable)
    // memfd_create is Android 11's: before it the pane says so and never decodes (see EntryPane).
    "pdf" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) PdfDocumentHolder.open(bytes)?.let { Shown.Pdf(it) } ?: Shown.Undecodable else Shown.Undecodable
    else -> {
        val text = bytes.decodeToString().removePrefix("\uFEFF")
        if (MarkdownDocument.handles(name, null) && bytes.size <= MarkdownDocument.LIMIT) Shown.Markdown(MarkdownDocument.parse(text))
        else Shown.Text(textBlocks(text))
    }
}

@Composable
private fun PictureView(image: androidx.compose.ui.graphics.ImageBitmap) {
    Box(Modifier.fillMaxSize().padding(AlpineSpace.S4), contentAlignment = Alignment.Center) {
        Image(image, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
    }
}

/*
 * A PDF from the bytes: PdfRenderer reads a seekable file descriptor, so the bytes go into an
 * anonymous memory file (memfd, Android 11 and later), never a file on storage. One renderer, used
 * from one thread of its own, never the main one.
 */
internal class PdfDocumentHolder private constructor(private val renderer: PdfRenderer) {
    val pages: Int = renderer.pageCount
    private val thread = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "archive-pdf") }
    val dispatcher = thread.asCoroutineDispatcher()

    /* Page `index` drawn `width` pixels wide, on the renderer's thread. */
    fun render(index: Int, width: Int): androidx.compose.ui.graphics.ImageBitmap? = runCatching {
        renderer.openPage(index).use { open ->
            val height = (width.toLong() * open.height / open.width.coerceAtLeast(1)).toInt().coerceIn(1, 8192)
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
                bitmap.eraseColor(android.graphics.Color.WHITE)
                open.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            }.asImageBitmap()
        }
    }.getOrNull()

    fun close() {
        thread.execute { runCatching { renderer.close() } }
        thread.shutdown()
    }

    companion object {
        @androidx.annotation.RequiresApi(Build.VERSION_CODES.R)
        fun open(bytes: ByteArray): PdfDocumentHolder? {
            // Each descriptor owned until it is handed on: the memfd closed whatever happens, its dup closed if the
            // renderer never takes it, the renderer closed if the holder never does.
            val fd = runCatching { Os.memfd_create("archive-entry", 0) }.getOrNull() ?: return null
            val parcel = try {
                FileOutputStream(fd).let { out -> out.write(bytes); out.flush() }
                Os.lseek(fd, 0, OsConstants.SEEK_SET)
                ParcelFileDescriptor.dup(fd)
            } catch (_: Exception) {
                return null
            } finally {
                runCatching { Os.close(fd) }
            }
            val renderer = try {
                PdfRenderer(parcel)
            } catch (_: Exception) {
                runCatching { parcel.close() }
                return null
            }
            return try {
                PdfDocumentHolder(renderer)
            } catch (_: Exception) {
                runCatching { renderer.close() }
                null
            }
        }
    }
}

@Composable
private fun PdfView(document: PdfDocumentHolder, onDownload: () -> Unit) {
    DisposableEffect(document) { onDispose { document.close() } }
    if (document.pages == 0) { Notice(ArchiveWords.CANT_SHOW, ArchiveWords.ELSEWHERE) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }; return }
    val width = with(androidx.compose.ui.platform.LocalDensity.current) { (androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp - 32.dp).roundToPx() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(document.pages) { index ->
            // Drawn on the renderer's thread as the page scrolls into view.
            var page by remember(index) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
            LaunchedEffect(index, width) { page = withContext(document.dispatcher) { document.render(index, width) } }
            val shown = page
            if (shown != null) Image(shown, contentDescription = "Page ${index + 1}", modifier = Modifier.fillMaxWidth())
            else Box(Modifier.fillMaxWidth().heightIn(min = 240.dp))
        }
    }
}

/* `index`: the item the password is asked for, tried on first, so a password that opens only some of the archive's items opens the one picked. */
@Composable
private fun PasswordCard(archive: OpenArchive, name: String, index: UInt, note: String?, failed: (Throwable, Boolean) -> String, onUnlocked: () -> Unit) {
    // Kept across a rotation or a fold (retain: in memory only, never the saved-state bundle), for
    // this archive's item alone, and gone with the card.
    var password by retain(archive, index) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    // `note` first (why it is asked again), until something is typed.
    var error by remember(note) { mutableStateOf(note) }
    val scope = rememberCoroutineScope()
    fun submit() {
        if (password.isEmpty() || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                if (archive.unlock(password, index)) onUnlocked() else error = ArchiveWords.WRONG_PASSWORD
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: Throwable) {
                error = failed(failure, false)
            } finally {
                busy = false
            }
        }
    }
    Notice(ArchiveWords.passwordTitle(name), icon = { Icon(Icons.Outlined.Lock, null, tint = Alpine.colors.inkMuted) }) {
        NoKeyboardLearning {
            PasswordField(password, { password = it; error = null }, ArchiveWords.PASSWORD_LABEL, error = error, enabled = !busy, onGo = ::submit)
        }
        Button(onClick = ::submit, enabled = password.isNotEmpty() && !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Alpine.colors.onPrimary) else Text(ArchiveWords.OPEN)
        }
    }
}

