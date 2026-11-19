package com.hushos.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.ImagesPdf
import com.hushos.app.data.Opened
import com.hushos.core.PageSize
import com.hushos.tokens.AlpineSpace

/*
 * Convert, then One PDF (docs/file-tools-design.md, feature (b)): the images in a list to put in
 * order (long-press a row's handle and drag, or its Move earlier and Move later buttons, which
 * TalkBack also offers as actions), the page size and margins, and the name, the first image's
 * with `.pdf`. Making it keeps the sheet up with its progress and Stop, which asks first; a stop, a
 * refusal or a failure leaves nothing in the folder (ImagesPdf.make cleans up).
 */
@Composable
fun ImagesPdfSheet(model: DriveViewModel, state: DriveState, images: List<Opened>, dismiss: () -> Unit) {
    // The order and the typed name (file names) are kept in memory across a rotation or a fold; the page size and
    // margins, which say nothing of the files, are saved with the screen's state.
    val order: SnapshotStateList<Opened> = retain { images.toMutableStateList() }
    var size by rememberSaveable { mutableStateOf(ImagesPdf.defaultSize()) }
    var margin by rememberSaveable { mutableStateOf(false) }
    // What the person typed; until then the name follows the first image.
    var typed by retain { mutableStateOf<String?>(null) }
    var askingStop by rememberSaveable { mutableStateOf(false) }
    // The run itself lives in the view model, so a rotation neither loses nor stops it.
    val run by model.pdfRun.collectAsState()
    val busy = run.running
    val progress = run.progress.takeIf { busy }
    val failure = run.failure
    LaunchedEffect(run.done) {
        if (run.done) {
            model.forgetImagesPdf()
            dismiss()
        }
    }
    val name = typed ?: ImagesPdf.pdfName(order.firstOrNull()?.name.orEmpty())
    val total = order.sumOf { it.size ?: 0L }
    val stage = ImagesPdf.stage(order.size, total)
    val alpine = Alpine.colors

    fun move(from: Int, to: Int) {
        if (to !in order.indices || from == to) return
        order.add(to, order.removeAt(from))
    }

    Sheet(onDismissRequest = { if (!busy) { model.forgetImagesPdf(); dismiss() } }, full = true) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S4),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            Text("One PDF", style = MaterialTheme.typography.titleLarge)
            Text("Order", style = MaterialTheme.typography.titleSmall)
            val rowHeight = 64.dp
            val rowPx = with(LocalDensity.current) { rowHeight.toPx() }
            Column {
                order.forEachIndexed { index, item -> key(item.id) {
                    // Keyed by the image, so its row (and a drag under way) moves with it when the order changes.
                    var lifted by remember { mutableFloatStateOf(0f) }
                    var dragging by remember { mutableStateOf(false) }
                    val locked by rememberUpdatedState(busy)
                    Row(
                        Modifier.fillMaxWidth().height(rowHeight)
                            .graphicsLayer { translationY = lifted; shadowElevation = if (dragging) 8f else 0f }
                            .background(alpine.surface)
                            .semantics {
                                stateDescription = "${index + 1} of ${order.size}"
                                customActions = listOf(
                                    CustomAccessibilityAction("Move earlier") { move(index, index - 1); true },
                                    CustomAccessibilityAction("Move later") { move(index, index + 1); true },
                                )
                            },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        LaunchedEffect(thumbnailKey(item)) { model.thumbnail(item) }
                        val thumbnail = state.thumbnails[thumbnailKey(item)]
                        val bitmap = remember(thumbnail) { thumbnail?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
                        Mark(item, bitmap, box = 40.dp)
                        Spacer(Modifier.width(AlpineSpace.S3))
                        Text(item.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        IconButton(enabled = !busy && index > 0, onClick = { move(index, index - 1) }) {
                            Icon(Icons.Outlined.KeyboardArrowUp, "Move ${item.name} earlier")
                        }
                        IconButton(enabled = !busy && index < order.lastIndex, onClick = { move(index, index + 1) }) {
                            Icon(Icons.Outlined.KeyboardArrowDown, "Move ${item.name} later")
                        }
                        // Long-press the handle, then drag: the row swaps with each neighbour it passes half way.
                        Icon(Icons.Outlined.DragHandle, null, tint = alpine.inkMuted, modifier = Modifier.size(44.dp).padding(10.dp)
                            .pointerInput(item.id) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = { dragging = true },
                                    onDragEnd = { dragging = false; lifted = 0f },
                                    onDragCancel = { dragging = false; lifted = 0f },
                                ) { change, amount ->
                                    if (locked) return@detectDragGesturesAfterLongPress
                                    change.consume()
                                    lifted += amount.y
                                    val at = order.indexOfFirst { it.id == item.id }
                                    if (lifted > rowPx / 2 && at < order.lastIndex) { move(at, at + 1); lifted -= rowPx }
                                    else if (lifted < -rowPx / 2 && at > 0) { move(at, at - 1); lifted += rowPx }
                                }
                            })
                    }
                } }
            }
            Text("Page size", style = MaterialTheme.typography.titleSmall)
            val sizes = listOf(PageSize.FIT to "Fit to each image", PageSize.A4 to "A4", PageSize.LETTER to "US Letter")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                sizes.forEachIndexed { i, (value, label) ->
                    SegmentedButton(selected = size == value, onClick = { size = value }, enabled = !busy,
                        shape = SegmentedButtonDefaults.itemShape(i, sizes.size)) { Text(label, maxLines = 1) }
                }
            }
            Text("Margins", style = MaterialTheme.typography.titleSmall)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf(false to "None", true to "12 mm").forEachIndexed { i, (value, label) ->
                    SegmentedButton(selected = margin == value, onClick = { margin = value }, enabled = !busy,
                        shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                }
            }
            OutlinedTextField(name, { typed = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Name") })
            Text("Location, camera and other photo details are left out. The colour profile is kept.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            when (stage) {
                ImagesPdf.Stage.OFFER -> Text("These images are ${formatBytes(total)}. Making the PDF uses a lot of memory and may be slow on this phone.")
                ImagesPdf.Stage.CEILING -> Text("These images are too many or too large for one PDF here: at most ${ImagesPdf.limits.maxImages} images and 256 MB.",
                    color = alpine.danger)
                ImagesPdf.Stage.FINE -> {}
            }
            progress?.let { (done, all) ->
                Text(if (done < all) "$done of $all ${if (all == 1) "image" else "images"}" else "Saving")
                LinearProgressIndicator(progress = { done.toFloat() / all.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
            }
            // One folder for all of them, or nothing is converted (search results can mix folders).
            val oneFolder = remember(images) { ImagesPdf.oneFolder(images) }
            if (!oneFolder) Text(ImagesPdf.MIXED_FOLDERS, color = alpine.danger)
            failure?.let { Text(it, color = alpine.danger) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (busy) TextButton(onClick = { askingStop = true }) { Text("Stop") }
                else TextButton(onClick = { model.forgetImagesPdf(); dismiss() }) { Text("Cancel") }
                val trimmed = name.trim()
                TextButton(
                    enabled = !busy && oneFolder && stage != ImagesPdf.Stage.CEILING && trimmed.isNotEmpty() && '/' !in trimmed,
                    onClick = { model.startImagesPdf(images, order.toList(), size, margin, trimmed) },
                ) {
                    Icon(Icons.Outlined.PictureAsPdf, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (stage == ImagesPdf.Stage.OFFER) "Continue" else "Make PDF")
                }
            }
        }
    }
    if (askingStop) AlertDialog(
        onDismissRequest = { askingStop = false },
        title = { Text("Stop making the PDF?") },
        text = { Text("What was made so far is deleted.") },
        confirmButton = {
            TextButton(onClick = {
                askingStop = false
                // The run cleans up and says how it stopped; the sheet shows that.
                model.stopImagesPdf()
            }) { Text("Stop", color = Alpine.colors.danger) }
        },
        dismissButton = { TextButton(onClick = { askingStop = false }) { Text("Keep going") } },
    )
}

/* Convert's choices for an image: for now, One PDF. */
@Composable
fun ConvertSheet(onePdf: () -> Unit, dismiss: () -> Unit) {
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.padding(bottom = AlpineSpace.S4)) {
            SheetRow("One PDF", Icons.Outlined.PictureAsPdf) { onePdf() }
        }
    }
}
