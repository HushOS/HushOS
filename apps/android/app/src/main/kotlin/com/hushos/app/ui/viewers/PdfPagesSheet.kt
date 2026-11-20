package com.hushos.app.ui.viewers

import android.graphics.pdf.PdfRenderer
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCut
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.RotateRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.transfers.PdfPages
import com.hushos.app.data.vault.Opened
import com.hushos.app.ui.Alpine
import com.hushos.app.ui.Sheet
import com.hushos.app.ui.drive.DriveState
import com.hushos.app.ui.drive.DriveViewModel
import com.hushos.app.ui.drive.formatBytes
import com.hushos.core.PdfPage
import com.hushos.core.PdfPagePlan
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * Edit pages (docs/file-tools-design.md, feature (c)): every page of the PDFs chosen, in a list to
 * put in order (each page's Move earlier and Move later buttons, which TalkBack also offers as
 * actions), to turn, to split after and to remove; then Save as a new version, a new file (one PDF
 * edited, several merged), one file a range when split, or images in a new folder. The core reads
 * and writes every PDF (PdfPages, lopdf); PdfRenderer draws the pages. Reading and saving live in
 * the view model, so a rotation keeps them; Stop asks first, and a stop, a refusal or a failure
 * leaves nothing in the folder.
 */
private data class PageItem(val id: String, val source: Int, val page: Int, val rotate: UInt, val info: PdfPage)

private enum class SaveAs { VERSION, FILE, IMAGES }

@Composable
fun PdfPagesSheet(model: DriveViewModel, state: DriveState, files: List<Opened>, dismiss: () -> Unit) {
    val run by model.pagesRun.collectAsState()
    val limits = remember { model.pdfPagesLimits() }
    val one = files.size == 1
    val total = files.sumOf { it.size ?: 0L }
    val stage = PdfPages.stage(files.size, total, limits)
    // The pages as the person left them, kept in memory across a rotation; the choices, saved with the screen.
    val items: SnapshotStateList<PageItem> = retain { mutableListOf<PageItem>().toMutableStateList() }
    var original by retain { mutableStateOf<List<PageItem>>(emptyList()) }
    val cuts: SnapshotStateList<String> = retain { mutableListOf<String>().toMutableStateList() }
    var mode by rememberSaveable { mutableStateOf(if (one) SaveAs.VERSION else SaveAs.FILE) }
    var typed by retain { mutableStateOf<String?>(null) }
    var png by rememberSaveable { mutableStateOf(true) }
    var dpi by rememberSaveable { mutableStateOf(150) }
    var asked by rememberSaveable { mutableStateOf(stage == PdfPages.Stage.FINE) }
    var askingStop by rememberSaveable { mutableStateOf(false) }
    val alpine = Alpine.colors
    val read = run.read
    val busy = run.saving

    LaunchedEffect(asked) {
        if (asked && stage != PdfPages.Stage.CEILING && run.read == null && !run.reading && run.failure == null) model.readPdfPages(files)
    }
    LaunchedEffect(read) {
        if (read != null && items.isEmpty()) {
            val list = read.inspections.flatMapIndexed { source, inspection ->
                inspection.pages.mapIndexed { page, info -> PageItem("$source:$page", source, page, info.rotate, info) }
            }
            items.addAll(list)
            original = list
        }
    }
    LaunchedEffect(run.done) {
        if (run.done) {
            model.forgetPdfPages()
            dismiss()
        }
    }
    // Each PDF opened once for drawing, off the main thread (each is written into a memory file first), and
    // closed with the sheet on a thread of its own, after any page still being drawn.
    var renderers by remember(read) { mutableStateOf<List<PdfRenderer?>?>(null) }
    LaunchedEffect(read) {
        val data = read?.data ?: return@LaunchedEffect
        // Opened whole even if the sheet goes meanwhile, so what was opened is always closed.
        val opened = withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) { data.map { PdfPages.renderer(it) } }
        if (kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.isActive == true) renderers = opened
        else Thread { opened.forEach { r -> r?.let { synchronized(it) { runCatching { it.close() } } } } }.start()
    }
    DisposableEffect(renderers) {
        val opened = renderers.orEmpty()
        onDispose {
            if (opened.isNotEmpty()) Thread {
                opened.forEach { r -> r?.let { synchronized(it) { runCatching { it.close() } } } }
            }.start()
        }
    }

    val ranges = PdfPages.ranges(items.size, items.indices.filter { items[it].id in cuts }.toSet())
    val split = ranges.size > 1
    val effective = if (mode == SaveAs.VERSION && (!one || split)) SaveAs.FILE else mode
    val name = typed ?: if (one) files[0].name else PdfPages.mergedName(files[0].name)
    val flags = read?.inspections.orEmpty()
    val signed = flags.any { it.signed }
    val forms = flags.any { it.outline || it.form }
    val imagesAre = PdfPages.imagesStage(items.size, limits)

    fun move(from: Int, to: Int) {
        if (to !in items.indices || from == to) return
        items.add(to, items.removeAt(from))
    }
    fun leave() {
        model.forgetPdfPages()
        dismiss()
    }

    Sheet(onDismissRequest = { if (!busy) leave() }, full = true, stayOpen = { busy.also { if (it) askingStop = true } }) {
        LazyColumn(Modifier.padding(horizontal = AlpineSpace.S4), contentPadding = PaddingValues(bottom = AlpineSpace.S4),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            item { Text("Edit pages", style = MaterialTheme.typography.titleLarge) }
            if (stage == PdfPages.Stage.CEILING) item {
                Text("These PDFs are too many or too large to edit on this phone: at most ${limits.maxFiles} files and ${formatBytes(limits.maxInputBytes.toLong())}.",
                    color = alpine.danger)
            } else if (!asked) item {
                Text("${if (one) "This PDF is" else "These PDFs are"} ${formatBytes(total)}. Editing ${if (one) "it" else "them"} uses a lot of memory and may be slow on this phone.")
            }
            if (run.reading) item {
                Text("Reading the pages")
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (items.isNotEmpty()) item { Text("${items.size} ${if (items.size == 1) "page" else "pages"}", style = MaterialTheme.typography.titleSmall) }
            itemsIndexed(items, key = { _, item -> item.id }) { index, item ->
                Row(
                    Modifier.fillMaxWidth().background(alpine.surface).semantics {
                        stateDescription = "${index + 1} of ${items.size}"
                        customActions = listOf(
                            CustomAccessibilityAction("Move earlier") { move(index, index - 1); true },
                            CustomAccessibilityAction("Move later") { move(index, index + 1); true },
                        )
                    },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PageThumbnail(renderers?.getOrNull(item.source), item)
                    Spacer(Modifier.width(AlpineSpace.S3))
                    Column(Modifier.weight(1f)) {
                        Text("Page ${index + 1}")
                        if (!one) Text(files[item.source].name, style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(enabled = !busy, onClick = { items[index] = item.copy(rotate = (item.rotate + 90u) % 360u) }) {
                        Icon(Icons.Outlined.RotateRight, "Rotate page ${index + 1}")
                    }
                    IconButton(enabled = !busy && index > 0, onClick = { move(index, index - 1) }) {
                        Icon(Icons.Outlined.KeyboardArrowUp, "Move page ${index + 1} earlier")
                    }
                    IconButton(enabled = !busy && index < items.lastIndex, onClick = { move(index, index + 1) }) {
                        Icon(Icons.Outlined.KeyboardArrowDown, "Move page ${index + 1} later")
                    }
                    IconToggleButton(checked = item.id in cuts && index < items.lastIndex, enabled = !busy && index < items.lastIndex,
                        onCheckedChange = { if (it) cuts.add(item.id) else cuts.remove(item.id) }) {
                        Icon(Icons.Outlined.ContentCut, "Split after page ${index + 1}",
                            tint = if (item.id in cuts && index < items.lastIndex) alpine.primary else alpine.inkMuted)
                    }
                    IconButton(enabled = !busy && items.size > 1, onClick = { cuts.remove(item.id); items.removeAt(index) }) {
                        Icon(Icons.Outlined.Delete, "Remove page ${index + 1}")
                    }
                }
            }
            if (read != null) item { Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                Text("Save as", style = MaterialTheme.typography.titleSmall)
                val options = buildList {
                    if (one && !split) add(SaveAs.VERSION to "New version")
                    add(SaveAs.FILE to if (split) "${ranges.size} files" else if (one) "New file" else "One file")
                    add(SaveAs.IMAGES to "Images")
                }
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    options.forEachIndexed { i, (value, label) ->
                        SegmentedButton(selected = effective == value, onClick = { mode = value }, enabled = !busy,
                            shape = SegmentedButtonDefaults.itemShape(i, options.size)) { Text(label, maxLines = 1) }
                    }
                }
                when {
                    effective == SaveAs.FILE && !split ->
                        OutlinedTextField(name, { typed = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Name") })
                    effective == SaveAs.FILE -> {
                        ranges.take(5).forEach { range -> Text(PdfPages.splitName(files[0].name, range.first + 1, range.last + 1), maxLines = 1) }
                        if (ranges.size > 5) Text("and ${ranges.size - 5} more", color = alpine.inkMuted)
                    }
                    effective == SaveAs.IMAGES -> {
                        Text("Format", style = MaterialTheme.typography.titleSmall)
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            listOf(true to "PNG", false to "JPEG").forEachIndexed { i, (value, label) ->
                                SegmentedButton(selected = png == value, onClick = { png = value }, enabled = !busy,
                                    shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                            }
                        }
                        Text("Resolution", style = MaterialTheme.typography.titleSmall)
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            listOf(150 to "150 dpi", 300 to "300 dpi").forEachIndexed { i, (value, label) ->
                                SegmentedButton(selected = dpi == value, onClick = { dpi = value }, enabled = !busy,
                                    shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                            }
                        }
                        if (renderers?.any { it == null } == true) Text(PdfPages.NO_RENDERER, color = alpine.danger)
                        if (imagesAre == PdfPages.Stage.OFFER) Text("Saving ${items.size} pages as images takes a while and uses a lot of memory.")
                        if (imagesAre == PdfPages.Stage.CEILING) Text("Save at most ${limits.imagesMaxPages} pages as images at a time.", color = alpine.danger)
                    }
                    else -> {}
                }
                if (effective != SaveAs.IMAGES && signed) Text(PdfPages.SIGNED)
                if (effective != SaveAs.IMAGES && forms) Text(PdfPages.FORMS)
            } }
            item { Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                run.progress?.takeIf { busy }?.let { (done, all) ->
                    Text("Saving")
                    LinearProgressIndicator(progress = { done.toFloat() / all.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
                }
                run.failure?.let { Text(it, color = alpine.danger) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (busy) TextButton(onClick = { askingStop = true }) { Text("Stop") }
                    else TextButton(onClick = ::leave) { Text("Cancel") }
                    if (!asked && stage == PdfPages.Stage.OFFER) TextButton(onClick = { asked = true }) { Text("Continue") }
                    else {
                        val trimmed = name.trim()
                        val ready = read != null && !busy && items.isNotEmpty() && when (effective) {
                            SaveAs.VERSION -> items.toList() != original && run.current != null
                            SaveAs.FILE -> split || (trimmed.isNotEmpty() && '/' !in trimmed)
                            SaveAs.IMAGES -> imagesAre != PdfPages.Stage.CEILING && renderers?.none { it == null } == true
                        }
                        TextButton(enabled = ready, onClick = {
                            val plan = items.map { PdfPagePlan(it.source.toUInt(), it.page.toUInt(), it.rotate) }
                            val choice = when (effective) {
                                SaveAs.VERSION -> PdfPages.Choice.Version(plan, run.current!!, files[0].node.currentVersion?.id)
                                SaveAs.FILE -> PdfPages.Choice.Files(
                                    if (split) ranges.map { PdfPages.splitName(files[0].name, it.first + 1, it.last + 1) to plan.slice(it) }
                                    else listOf(trimmed to plan),
                                )
                                SaveAs.IMAGES -> PdfPages.Choice.Images(plan, png, dpi.toUInt(), PdfPages.imagesFolderName(files[0].name))
                            }
                            model.savePdfPages(files, choice)
                        }) { Text("Save") }
                    }
                }
            } }
        }
    }
    if (askingStop) AlertDialog(
        onDismissRequest = { askingStop = false },
        title = { Text("Stop saving?") },
        text = { Text("What was made so far is deleted.") },
        confirmButton = {
            TextButton(onClick = { askingStop = false; model.stopPdfPages() }) { Text("Stop", color = Alpine.colors.danger) }
        },
        dismissButton = { TextButton(onClick = { askingStop = false }) { Text("Keep going") } },
    )
}

/* A page drawn small by PdfRenderer, off the main thread, turned as the list has it. */
@Composable
private fun PageThumbnail(renderer: PdfRenderer?, item: PageItem) {
    var image by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(renderer, item.id, item.rotate) {
        val drawn = renderer?.let {
            withContext(Dispatchers.Default) {
                val turned = item.rotate == 90u || item.rotate == 270u
                val (w, h) = if (turned) item.info.height to item.info.width else item.info.width to item.info.height
                val scale = 112.0 / maxOf(w, h, 1.0)
                synchronized(it) { PdfPages.draw(it, item.page, item.info.rotate, item.rotate, maxOf(1, (w * scale).toInt()), maxOf(1, (h * scale).toInt())) }
            }
        }
        image = drawn?.asImageBitmap()
    }
    Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
        image?.let { Image(it, contentDescription = null, modifier = Modifier.size(56.dp)) }
    }
}
