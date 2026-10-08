package com.hushos.app.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineSpace

private val tileShape = RoundedCornerShape(AlpineRadius.Card)

/* How many tiles fit across `width`: each at least 150dp, 12dp apart, inside the list's 16dp margins. */
fun gridColumns(width: Dp): Int = maxOf(1, ((width - AlpineSpace.S4 * 2 + AlpineSpace.S3) / (150.dp + AlpineSpace.S3)).toInt())

/* One line of a grid inside a list: `count` tiles in `columns` equal slots, the last line left-aligned. */
@Composable
fun TileRow(columns: Int, count: Int, tile: @Composable (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S4, end = AlpineSpace.S4, bottom = AlpineSpace.S3), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
        for (slot in 0 until columns) Box(Modifier.weight(1f)) { if (slot < count) tile(slot) }
    }
}

/*
 * One node in a grid: a 4:3 card (a photo or video's thumbnail, or its 72dp mark), the
 * name, and the row's line without the date. Selecting tints the tile and puts a
 * circle in the picture's corner; a long press opens the item sheet, as there is no ⋮.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NodeTile(
    model: DriveViewModel, state: DriveState, item: Opened, onClick: () -> Unit, onLongClick: () -> Unit,
    /* The item sheet, offered to accessibility services as "Actions"; null while selecting. */
    onActions: (() -> Unit)? = null,
    selecting: Boolean = false,
    selected: Boolean = false,
    /* Offline and not on this phone: dimmed, and it says so. */
    away: Boolean = false,
) {
    val alpine = Alpine.colors
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    // Only a photo or a video fills the picture; a PDF's first page, cropped to 4:3, is mostly white margin, so it keeps its mark.
    val pictured = mimeOf(item)?.let { it.startsWith("image/") || it.startsWith("video/") } == true
    val bitmap = remember(thumbnail, pictured) { thumbnail?.takeIf { pictured }?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    val who = shownWho(model, state, item)
    val kept = model.keptMark(item, state)
    val keepProblem = keepProblemOf(state, item)
    // The row's line without the date: a file's size; a folder says what it is when nothing else does.
    val time = if (away) "Not on this phone" else item.size?.let { formatBytes(it) } ?: if (item.isFolder && who == null) "Folder" else null
    val spoken = state.opening[item.id]?.let { "Opening, ${(it * 100).toInt()}%" }
        ?: listOfNotNull(who?.label(), if (kept) "Kept on this phone" else null, time, keepProblem).joinToString(", ")
    val tint = alpine.tint
    val presses = remember { MutableInteractionSource() }
    Box {
        Column(
            Modifier.fillMaxWidth()
                // The row's selection tint, reaching a little past the tile so the picture sits inside it.
                .drawBehind {
                    if (selected) {
                        val out = 4.dp.toPx()
                        drawRoundRect(tint, Offset(-out, -out), Size(size.width + out * 2, size.height + out * 2), CornerRadius(AlpineRadius.Sheet.toPx()))
                    }
                }
                .combinedClickable(interactionSource = presses, indication = null, onClick = onClick, onLongClick = onLongClick, onLongClickLabel = if (onActions != null) "Actions" else null)
                // One element to a screen reader: the name and the line, whether it is selected, and the sheet as an action.
                .clearAndSetSemantics {
                    contentDescription = listOf(item.name, spoken).filter { it.isNotEmpty() }.joinToString(", ")
                    if (selecting) this.selected = selected
                    if (onActions != null) customActions = listOf(CustomAccessibilityAction("Actions") { onActions(); true })
                },
        ) {
            Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f)) {
                Box(Modifier.matchParentSize().alpha(if (away) 0.5f else 1f).clip(tileShape).background(alpine.surface), contentAlignment = Alignment.Center) {
                    if (bitmap != null) {
                        // A hairline edge, as the row's mark has, so a white photo still has a shape.
                        Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize().border(1.dp, alpine.edge, tileShape))
                        if (mimeOf(item)?.startsWith("video/") == true) PlayBadge(72.dp)
                    } else Mark(item, null, box = 72.dp)
                }
                if (selecting) Box(
                    Modifier.align(Alignment.TopStart).padding(AlpineSpace.S2).size(24.dp)
                        .then(if (selected) Modifier.background(alpine.primary, CircleShape) else Modifier.background(alpine.surface, CircleShape).border(1.5.dp, alpine.field, CircleShape)),
                    contentAlignment = Alignment.Center,
                ) { if (selected) Icon(Icons.Outlined.Check, null, tint = alpine.onPrimary, modifier = Modifier.size(16.dp)) }
            }
            Column(Modifier.padding(top = 6.dp).alpha(if (away) 0.5f else 1f)) {
                Text(item.name, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ItemLine(model, state, item, who, time, keepProblem, maxLines = 1, color = alpine.inkMuted)
            }
        }
        // The press ripple, rounded like the picture, on its own layer: clipping the tile itself would cut the line's first letter at the corner.
        Box(Modifier.matchParentSize().clip(tileShape).indication(presses, ripple()))
    }
}

/* The grid's loading state: a picture block and two bars per tile, pulsing as the rows' skeleton does. */
@Composable
fun SkeletonTiles(columns: Int, tiles: Int = 7) {
    val alpine = Alpine.colors
    val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(0.05f, 0.1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse")
    Column(Modifier.semantics { contentDescription = "Loading" }) {
        for (start in 0 until tiles step columns) TileRow(columns, minOf(columns, tiles - start)) { slot ->
            val i = start + slot
            Column {
                Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).background(alpine.ink.copy(alpha = pulse), tileShape))
                Box(Modifier.padding(top = 10.dp).fillMaxWidth((70 - (i * 13) % 30) / 100f).height(12.dp).background(alpine.ink.copy(alpha = pulse), CircleShape))
                Box(Modifier.padding(top = AlpineSpace.S2).fillMaxWidth(0.4f).height(10.dp).background(alpine.ink.copy(alpha = pulse * 0.7f), CircleShape))
            }
        }
    }
}
