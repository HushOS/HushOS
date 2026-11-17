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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import kotlinx.coroutines.Job
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

/* The person's words for what a call met. */
internal fun archiveFailure(error: Throwable): String = when (error) {
    is ArchiveException.Refused -> ArchiveWords.refusal(error.code)
    is ToolFailed -> error.message ?: toolFailedMessage()
    else -> toolFailedMessage()
}

@Composable
fun ArchiveScreen(model: DriveViewModel, item: Opened, close: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var archive by remember(item.id) { mutableStateOf<OpenArchive?>(null) }
    var failure by remember(item.id) { mutableStateOf<String?>(null) }
    var attempt by remember(item.id) { mutableStateOf(0) }
    var path by remember(item.id) { mutableStateOf(listOf<String>()) }
    var opened by remember(item.id) { mutableStateOf<ArchiveEntry?>(null) }
    var unlocked by remember(item.id) { mutableStateOf(false) }
    var asking by remember(item.id) { mutableStateOf<ArchiveEntry?>(null) }
    val downloads = remember(item.id) { mutableStateListOf<EntryDownload>() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(item.id, attempt) {
        failure = null
        archive = try {
            model.openArchive(item)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            failure = archiveFailure(error)
            null
        }
    }
    // The screen going (Back, a sign-out) closes the archive: its password goes with it.
    DisposableEffect(item.id) { onDispose { archive?.close() } }
    val current = archive
    DisposableEffect(current) { onDispose { current?.close() } }
    val tree = remember(current) { current?.let { ArchiveTree(it.entries) } }

    // Downloads stream into the file the person picks (SAF): no copy of the entry is made anywhere else.
    var waitingFor by remember { mutableStateOf<ArchiveEntry?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val entry = waitingFor ?: return@rememberLauncherForActivityResult
        waitingFor = null
        val open = current ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        val record = EntryDownload(entry)
        downloads.add(record)
        record.job = scope.launch {
            val resolver = context.contentResolver
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    resolver.openOutputStream(uri, "w")!!.use { out ->
                        open.download(entry.index, object : EntrySink {
                            override fun write(chunk: ByteArray) {
                                try {
                                    out.write(chunk)
                                } catch (error: Exception) {
                                    throw FetchException.Failed(error.message ?: "The file couldn't be written.")
                                }
                                record.written.value += chunk.size
                            }
                        })
                    }
                }
            }
            result.exceptionOrNull()?.let { error ->
                // Nothing half-written is left where the person put it.
                runCatching { android.provider.DocumentsContract.deleteDocument(resolver, uri) }
                if (error is CancellationException) { downloads.remove(record); throw error }
                record.error.value = archiveFailure(error)
            } ?: run {
                downloads.remove(record)
                model.notify(ArchiveWords.DOWNLOADED)
            }
        }
    }
    fun download(entry: ArchiveEntry) {
        if (entry.lock != "none" && !unlocked) { opened = entry; return }
        if (zipEntryAsksFirst(entry.size, entry.packed)) { asking = entry; return }
        waitingFor = entry
        picker.launch(entry.parts.last())
    }

    fun back() {
        when {
            opened != null -> opened = null
            path.isNotEmpty() -> path = path.dropLast(1)
            else -> close()
        }
    }

    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = ::back)
        Scaffold(containerColor = alpine.ground, topBar = { DestinationBar(item.name, onBack = ::back) }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                when {
                    failure != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        EmptyState(ArchiveWords.CANT_SHOW, failure) {
                            Button(onClick = { attempt++ }) { Text(ArchiveWords.TRY_AGAIN) }
                        }
                    }
                    current == null || tree == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        CircularProgressIndicator(color = alpine.primary, modifier = Modifier.padding(top = 48.dp))
                    }
                    else -> {
                        Crumbs(item.name, path, opened) { to -> opened = null; path = to }
                        HorizontalDivider(color = alpine.rule)
                        Box(Modifier.weight(1f)) {
                            val entry = opened
                            if (entry != null) EntryPane(current, entry, unlocked, onUnlocked = { unlocked = true }, onDownload = { download(entry) })
                            else EntryList(tree.rows(path), unlocked, current.hidden, onFolder = { path = path + it }, onOpen = { opened = it }, onDownload = ::download)
                        }
                        for (record in downloads) DownloadBar(record) { record.job?.cancel(); downloads.remove(record) }
                    }
                }
            }
        }
        asking?.let { entry ->
            AlertDialog(
                onDismissRequest = { asking = null },
                title = { Text(ArchiveWords.asksFirst(entry.size.toLong(), entry.packed.toLong())) },
                confirmButton = { TextButton(onClick = { asking = null; waitingFor = entry; picker.launch(entry.parts.last()) }) { Text(ArchiveWords.DOWNLOAD) } },
                dismissButton = { TextButton(onClick = { asking = null }) { Text(ArchiveWords.CANCEL) } },
            )
        }
    }
}

class EntryDownload(val entry: ArchiveEntry) {
    val written = mutableStateOf(0L)
    val error = mutableStateOf<String?>(null)
    var job: Job? = null
}

@Composable
private fun DownloadBar(record: EntryDownload, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val error by record.error
    val written by record.written
    Row(Modifier.fillMaxWidth().background(alpine.surface).heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
        Text(error ?: ArchiveWords.downloading(record.entry.parts.last()), style = MaterialTheme.typography.bodyMedium, color = if (error != null) alpine.danger else alpine.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (error == null && record.entry.size > 0uL) Text("${(written * 100 / record.entry.size.toLong()).coerceIn(0, 100)}%", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        IconButton(onClick = dismiss) { Icon(Icons.Outlined.Close, if (error != null) "Dismiss" else ArchiveWords.STOP) }
    }
}

/* The archive's name, then each folder down to where you are: each one a step back up. */
@Composable
private fun Crumbs(name: String, path: List<String>, opened: ArchiveEntry?, go: (List<String>) -> Unit) {
    val alpine = Alpine.colors
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).heightIn(min = 48.dp).padding(horizontal = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val steps = listOf(name) + path + listOfNotNull(opened?.parts?.last())
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
                    .then(if (last) Modifier else Modifier.clickable(role = Role.Button) { go(path.take(index)) })
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
    onFolder: (String) -> Unit,
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
                is ArchiveTree.Row.Folder -> EntryRow(row.name, ArchiveWords.items(row.count), folder = true, onClick = { onFolder(row.name) })
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

private sealed interface Shown {
    data object Loading : Shown
    data class Failed(val message: String) : Shown
    data class Bytes(val bytes: ByteArray) : Shown
}

@Composable
private fun EntryPane(archive: OpenArchive, entry: ArchiveEntry, unlocked: Boolean, onUnlocked: () -> Unit, onDownload: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val name = entry.parts.last()
    val kind = remember(name) { ArchiveTree.previewKind(name) }
    val limits = remember(kind) { zipEntryPreviewLimits(kind, deviceMemory(context).toULong()) }
    var continued by remember(entry.index) { mutableStateOf(false) }
    val size = entry.size.toLong()
    val locked = entry.lock != "none" && !unlocked
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
            Text(listOfNotNull(formatBytes(size), whenText(ArchiveTree.modifiedMillis(entry))).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.weight(1f))
            if (entry.support == "ok" && !locked) OutlinedButton(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) }
        }
        HorizontalDivider(color = alpine.rule)
        Box(Modifier.weight(1f)) {
            when {
                locked -> PasswordCard(archive, name, onUnlocked)
                entry.support == "method" -> Notice(name, ArchiveWords.METHOD)
                entry.support == "encryption" -> Notice(name, ArchiveWords.ENCRYPTION)
                entry.nested -> Notice(name, ArchiveWords.NESTED) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
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
                else -> EntryPreview(archive, entry, kind, limits.ceiling.toLong(), onDownload)
            }
        }
    }
}

@Composable
private fun EntryPreview(archive: OpenArchive, entry: ArchiveEntry, kind: String, limit: Long, onDownload: () -> Unit) {
    val alpine = Alpine.colors
    var shown by remember(entry.index) { mutableStateOf<Shown>(Shown.Loading) }
    LaunchedEffect(entry.index) {
        shown = try {
            Shown.Bytes(archive.preview(entry.index, limit))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Shown.Failed(archiveFailure(error))
        }
    }
    when (val now = shown) {
        Shown.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) { CircularProgressIndicator(color = alpine.primary, modifier = Modifier.padding(top = 48.dp)) }
        is Shown.Failed -> Notice(ArchiveWords.CANT_SHOW, now.message) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }
        is Shown.Bytes -> when (kind) {
            "image" -> ImageBytes(now.bytes, onDownload)
            "pdf" -> PdfBytes(now.bytes, onDownload)
            else -> TextBytes(entry.parts.last(), now.bytes)
        }
    }
}

/* A picture decoded from the bytes, no larger than the screen needs. */
@Composable
private fun ImageBytes(bytes: ByteArray, onDownload: () -> Unit) {
    val decoded = remember(bytes) {
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                val longest = maxOf(info.size.width, info.size.height)
                if (longest > 4096) {
                    val scale = 4096f / longest
                    decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }.asImageBitmap()
        }.getOrNull()
    }
    if (decoded == null) { Notice(ArchiveWords.CANT_SHOW, ArchiveWords.ELSEWHERE) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }; return }
    Box(Modifier.fillMaxSize().padding(AlpineSpace.S4), contentAlignment = Alignment.Center) {
        Image(decoded, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
    }
}

/* Text and Markdown from the bytes: Markdown drawn as a document up to its limit, anything else as text in blocks. */
@Composable
private fun TextBytes(name: String, bytes: ByteArray) {
    val alpine = Alpine.colors
    val text = remember(bytes) { bytes.decodeToString().removePrefix("﻿") }
    val markdown = remember(name) { MarkdownDocument.handles(name, null) } && bytes.size <= MarkdownDocument.LIMIT
    val blocks = remember(text, markdown) { if (markdown) MarkdownDocument.parse(text) else null }
    if (blocks != null) {
        LazyColumn(Modifier.fillMaxSize().readableWidth(720.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            itemsIndexed(blocks) { _, block -> SelectionContainer { MarkdownBlockView(block) } }
        }
        return
    }
    // In blocks of 200 lines: one Text the size of an 8 MB file would be laid out whole.
    val pieces = remember(text) { text.lineSequence().chunked(200).map { it.joinToString("\n") }.toList() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
        items(pieces.size) { index ->
            SelectionContainer {
                Text(pieces[index], style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = alpine.ink, modifier = Modifier.horizontalScroll(rememberScrollState()))
            }
        }
    }
}

/*
 * A PDF from the bytes: PdfRenderer reads a seekable file descriptor, so the bytes go into an
 * anonymous memory file (memfd, Android 11 and later), never a file on storage. Pages are drawn as
 * they scroll into view, one bitmap each at the screen's width.
 */
@Composable
private fun PdfBytes(bytes: ByteArray, onDownload: () -> Unit) {
    val renderer = remember(bytes) {
        runCatching {
            val fd = Os.memfd_create("archive-entry", 0)
            FileOutputStream(fd).let { out -> out.write(bytes); out.flush() }
            Os.lseek(fd, 0, OsConstants.SEEK_SET)
            val parcel = ParcelFileDescriptor.dup(fd)
            Os.close(fd)
            PdfRenderer(parcel)
        }.getOrNull()
    }
    DisposableEffect(renderer) { onDispose { renderer?.close() } }
    if (renderer == null) { Notice(ArchiveWords.CANT_SHOW, ArchiveWords.ELSEWHERE) { Button(onClick = onDownload) { Text(ArchiveWords.DOWNLOAD) } }; return }
    val width = with(androidx.compose.ui.platform.LocalDensity.current) { (androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp - 32.dp).roundToPx() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(renderer.pageCount) { index ->
            val page = remember(index) {
                synchronized(renderer) {
                    runCatching {
                        renderer.openPage(index).use { open ->
                            val height = (width.toLong() * open.height / open.width.coerceAtLeast(1)).toInt().coerceIn(1, 8192)
                            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
                                bitmap.eraseColor(android.graphics.Color.WHITE)
                                open.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            }.asImageBitmap()
                        }
                    }.getOrNull()
                }
            }
            page?.let { Image(it, contentDescription = "Page ${index + 1}", modifier = Modifier.fillMaxWidth()) }
        }
    }
}

@Composable
private fun PasswordCard(archive: OpenArchive, name: String, onUnlocked: () -> Unit) {
    // Kept in memory only (remember, never saved state), and gone with the card.
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun submit() {
        if (password.isEmpty() || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                if (archive.unlock(password)) onUnlocked() else error = ArchiveWords.WRONG_PASSWORD
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: Throwable) {
                error = archiveFailure(failure)
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

