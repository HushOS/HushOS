package com.hushos.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.tokens.AlpineSpace
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

fun formatBytes(bytes: Long): String {
    // The web's rule, so a size reads the same everywhere: counted in 1024s, labelled as people know them
    // (KB, MB, GB, TB), whole numbers from 100 up.
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = -1
    while (value >= 1024 && unit < units.size - 1) { value /= 1024; unit++ }
    return if (value >= 100) "${Math.round(value)} ${units[unit]}" else String.format(Locale.US, "%.1f %s", value, units[unit])
}

/* A quota as the web writes it: GB, or TB from 1024 GB, counted in 1024s, no trailing ".0" ("1 GB", "200 GB", "1.5 TB"). */
fun formatQuota(bytes: Long): String {
    val gib = bytes / 1_073_741_824.0
    val (value, unit) = if (gib >= 1024) gib / 1024 to "TB" else gib to "GB"
    val shown = java.text.NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2 }.format(value)
    return "$shown $unit"
}

/* Space used, written like the quota beside it: "2 GB" from a gigabyte up, else the plain size ("423 MB"). */
fun formatSpace(bytes: Long): String = if (bytes >= 1_073_741_824L) formatQuota(bytes) else formatBytes(bytes)

fun mimeOf(item: Opened): String? = mimeFor(item.name, item.metadata.mime)

/* A file's type: what its metadata says, or, when that says nothing useful, what its name's extension means (.xlsx, .docx, .pdf). */
fun mimeFor(name: String, recorded: String?): String? =
    recorded?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
        ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
        ?: recorded

/* When something changed, as people say it: "Today, 14:02", "Yesterday", "3 Sept", "3 Sept 2024". */
fun whenText(millis: Long?): String? {
    millis ?: return null
    val zone = ZoneId.systemDefault()
    val at = Instant.ofEpochMilli(millis).atZone(zone)
    val today = LocalDate.now(zone)
    val day = at.toLocalDate()
    // Day and month the en-GB way on every client ("29 Sept"), as the web writes them; the time keeps the phone's own clock.
    val pattern = { skeleton: String -> DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(Locale.UK, skeleton), Locale.UK) }
    return when {
        day == today -> "Today, " + DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(at)
        day == today.minusDays(1) -> "Yesterday"
        day.year == today.year -> pattern("dMMM").format(at)
        else -> pattern("dMMMyyyy").format(at)
    }
}

/*
 * One node in a list, as the board draws it: 56dp, a 36dp mark, the name, and a
 * line saying who can open it and when it changed. Selecting tints the row and
 * puts a check where the mark was; ⋮ opens the item sheet.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NodeRow(
    model: DriveViewModel, state: DriveState, item: Opened, onClick: () -> Unit, onLongClick: () -> Unit,
    /* Takes the date's place: the trash's "Trashed 3 Sept", search's "In Lisbon 2026", a kept file's size. */
    note: String? = null,
    /* Picked while selecting: the row takes the selection tint and its mark becomes a check. */
    selected: Boolean = false,
    /* Something is being done to it (a restore or a delete in the trash): a ring until it is over. */
    working: Boolean = false,
    /* The item sheet; hidden while selecting. */
    onMore: (() -> Unit)? = null,
    selecting: Boolean = false,
    /* Offline and not on this phone: dimmed, and it says so. */
    away: Boolean = false,
    /* The note says something went wrong (the trash's "Couldn’t be restored"): it reads in red. */
    noteIsProblem: Boolean = false,
    /* In Recent: the date is when it changed in HushOS, which Recent is ordered by, not the file's own. */
    recent: Boolean = false,
) {
    val alpine = Alpine.colors
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    // Who can open it only when that differs from its folder: an item shared on its own. Otherwise the date, and a file's size.
    val who = shownWho(model, state, item, note)
    val time = if (away) "Not on this phone" else note ?: listOfNotNull(whenText(if (recent) item.changedMillis else item.modifiedMillis), item.size?.let { formatBytes(it) }).joinToString(" · ").ifEmpty { null }
    val keepProblem = keepProblemOf(state, item, note)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .background(if (selected) alpine.tint else Color.Transparent)
            .semantics { this.selected = selected }
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = AlpineSpace.S4, end = if (onMore != null && !selecting) AlpineSpace.S1 else AlpineSpace.S4),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).alpha(if (away) 0.5f else 1f), contentAlignment = Alignment.Center) {
            if (selected) Box(Modifier.size(36.dp).background(alpine.primary, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Check, "Selected", tint = alpine.onPrimary, modifier = Modifier.size(22.dp))
            } else Mark(item, bitmap)
        }
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4, top = 6.dp, bottom = 6.dp).alpha(if (away) 0.5f else 1f)) {
            // A long name gets a second line at large font sizes before it is cut; one line at the usual size.
            val nameLines = if (androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.5f) 2 else 1
            Text(item.name, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, maxLines = nameLines, overflow = TextOverflow.Ellipsis)
            ItemLine(model, state, item, who, time, keepProblem, maxLines = 3, color = if (noteIsProblem) alpine.danger else alpine.inkMuted)
        }
        when {
            working -> CircularProgressIndicator(modifier = Modifier.padding(horizontal = 13.dp).size(22.dp), strokeWidth = 2.5.dp)
            // Fetching to open: a small ring on the row, as the drives do, not a banner.
            state.opening[item.id] != null -> {
                val fraction = state.opening[item.id] ?: 0f
                val ring = Modifier.padding(horizontal = 13.dp).size(22.dp)
                if (fraction > 0f) CircularProgressIndicator(progress = { fraction }, modifier = ring, strokeWidth = 2.5.dp)
                else CircularProgressIndicator(modifier = ring, strokeWidth = 2.5.dp)
            }
            onMore != null && !selecting -> IconButton(onClick = onMore) { Icon(Icons.Outlined.MoreVert, "More for ${item.name}", tint = alpine.inkMuted) }
        }
    }
}

/* Who can open it, on its line only when that differs from its folder: an item shared on its own. */
fun shownWho(model: DriveViewModel, state: DriveState, item: Opened, note: String? = null): WhoCanOpen? =
    if (note == null || note.startsWith("In ")) whoCanOpen(model, state, item)?.takeIf { it is WhoCanOpen.People || it == WhoCanOpen.AnyoneWithLink } else null

/* A file of a kept folder that couldn't be kept, or a kept folder with such files: said in red (tried again later; the menu has Retry). */
fun keepProblemOf(state: DriveState, item: Opened, note: String? = null): String? = when {
    item.isFolder -> com.hushos.app.data.KeepRules.folderLine(state.keepFailures.count { it.folderId == item.id })
    note != null -> null
    state.keepFailures.any { it.fileId == item.id } -> "Couldn’t be kept"
    else -> null
}

/*
 * The muted line under a name, for a row and a tile alike. While a file is fetched to open, it says so.
 * The link icon (Hush blue) first when anyone with the link can open it, then who can open it, then a small phone
 * (kept on this phone, as Home's row) before `time`, all in the muted colour. One line when it fits;
 * otherwise it wraps up to `maxLines` (large font sizes), breaking only between the "·" parts: each part stays whole.
 */
@Composable
fun ItemLine(model: DriveViewModel, state: DriveState, item: Opened, who: WhoCanOpen?, time: String?, keepProblem: String?, maxLines: Int, color: Color) {
    val alpine = Alpine.colors
    val line = state.opening[item.id]?.let { "Opening · ${(it * 100).toInt()}%" } ?: listOfNotNull(who?.label(), time).joinToString(" · ")
    val kept = model.keptMark(item, state)
    val opening = state.opening[item.id] != null
    val linked = who == WhoCanOpen.AnyoneWithLink && !opening
    // Up to three of its tags as dots after the line, as iOS and the web mark them.
    val tags = state.tags.tagsOf(item.id)
    if (line.isEmpty() && !kept && keepProblem == null && tags.isEmpty()) return
    val text = androidx.compose.ui.text.buildAnnotatedString {
        val whole = { part: String -> part.replace(' ', '\u00A0').replace('\u202F', '\u00A0') }
        val parts = { part: String -> part.split(" · ").joinToString(" · ") { whole(it) } }
        if (opening) append(line) else {
            if (linked) { appendInlineContent("link", "\u200B"); append("\u00A0") }
            who?.label()?.let { append(whole(it)); if (time != null || kept) append(" · ") }
            if (kept) { appendInlineContent("phone", "Kept on this phone, "); append("\u00A0") }
            time?.let { append(parts(it)) }
        }
        // Only the problem itself reads in red, after the usual line.
        if (keepProblem != null && !opening) {
            if (length > 0) append(" · ")
            pushStyle(androidx.compose.ui.text.SpanStyle(color = alpine.danger, fontWeight = FontWeight.SemiBold)); append(keepProblem); pop()
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (text.isNotEmpty()) Text(
            text, style = MaterialTheme.typography.bodyMedium, maxLines = maxLines, overflow = TextOverflow.Ellipsis, color = color,
            inlineContent = mapOf("link" to subtitleGlyph(Icons.Outlined.Link, alpine.primary), "phone" to subtitleGlyph(Icons.Outlined.Smartphone, alpine.inkMuted)),
            modifier = Modifier.weight(1f, fill = false),
        )
        if (tags.isNotEmpty()) Row(
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "Tags: " + tags.joinToString(", ") { it.name } },
        ) { tags.take(3).forEach { TagDot(it.colour, dark = alpine.dark) } }
    }
}

private val folderBack = PathParser().parsePathString("M0 6a6 6 0 0 1 6-6h14l6 6h24a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6Z").toPath()
private val folderFront = PathParser().parsePathString("M0 14a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V14Z").toPath()
private val sheetOutline = PathParser().parsePathString("M4 1h25.6L43 14.4V50a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z").toPath()
private val sheetCorner = PathParser().parsePathString("M29.5 1v10a3.5 3.5 0 0 0 3.5 3.5h10").toPath()
private val playTriangle = Path().apply { moveTo(8f, 5.5f); lineTo(8f, 18.5f); lineTo(19f, 12f); close() }

/*
 * What an item looks like at a glance: its own thumbnail when it has one (photos,
 * PDF pages, video frames, made at upload), a two-sheet folder, or a plain page
 * with its type on a label.
 */
@Composable
fun Mark(item: Opened, bitmap: ImageBitmap?, box: Dp = 36.dp) {
    val alpine = Alpine.colors
    if (bitmap != null) {
        val shape = RoundedCornerShape(box * 0.22f)
        Box(Modifier.size(box), contentAlignment = Alignment.Center) {
            // A hairline edge, so a white photo still has a shape on a white list.
            Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize().clip(shape).border(1.dp, alpine.edge, shape))
            if (mimeOf(item)?.startsWith("video/") == true) PlayBadge(box)
        }
        return
    }
    if (item.isFolder) {
        Canvas(Modifier.size(box)) {
            val w = size.width * 0.86f
            val s = w / 56f
            translate((size.width - w) / 2, (size.height - 46f * s) / 2) {
                scale(s, s, pivot = Offset.Zero) {
                    drawPath(folderBack, alpine.folderBack)
                    drawPath(folderFront, alpine.folderFront)
                }
            }
        }
        return
    }
    PageMark(item.name, box)
}

/* A video's play badge, centred on its frame; `box` is the mark's size, which the badge is drawn in proportion to. */
@Composable
fun PlayBadge(box: Dp) {
    Canvas(Modifier.size(box * 0.42f)) {
        drawCircle(Color.Black.copy(alpha = 0.45f))
        val s = size.width / 0.42f * 0.2f / 24f
        translate(size.width / 2 - 12f * s, size.height / 2 - 12f * s) { scale(s, s, pivot = Offset.Zero) { drawPath(playTriangle, Color.White) } }
    }
}

/* A plain page with its type on a label, for a file that is not an item yet (Save to HushOS's list). */
@Composable
fun PageMark(name: String, box: Dp = 36.dp) {
    val alpine = Alpine.colors
    val label = name.substringAfterLast('.', "").uppercase().takeIf { it.isNotEmpty() && it.length <= 4 && it != name.uppercase() }
    val measurer = rememberTextMeasurer()
    Canvas(Modifier.size(box)) {
        val w = size.width * 0.66f
        val s = w / 44f
        translate((size.width - w) / 2, (size.height - 54f * s) / 2) {
            scale(s, s, pivot = Offset.Zero) {
                drawPath(sheetOutline, alpine.surface)
                drawPath(sheetOutline, alpine.field, style = Stroke(2f))
                drawPath(sheetCorner, alpine.field, style = Stroke(2f))
                if (label == null) {
                    drawRoundRect(alpine.rule, Offset(8f, 22f), Size(22f, 3f), CornerRadius(1.5f))
                    drawRoundRect(alpine.rule, Offset(8f, 29f), Size(27f, 3f), CornerRadius(1.5f))
                    drawRoundRect(alpine.rule, Offset(8f, 36f), Size(18f, 3f), CornerRadius(1.5f))
                }
            }
            if (label != null) {
                // The label is drawn at the screen's scale, so its letters stay crisp.
                val top = 34f * s
                val labelWidth = 27f * s
                drawRoundRect(alpine.ink, Offset(6f * s, top), Size(labelWidth, 13f * s), CornerRadius(3f * s))
                val text = measurer.measure(label, TextStyle(color = alpine.surface, fontSize = (8.5f * s).toSp(), fontWeight = FontWeight.Bold))
                drawText(text, topLeft = Offset(6f * s + (labelWidth - text.size.width) / 2, top + (13f * s - text.size.height) / 2))
            }
        }
    }
}

/* The two-sheet folder on its own, for places that are not items (the move picker's rows). */
@Composable
fun FolderMark(box: Dp = 36.dp) {
    val alpine = Alpine.colors
    Canvas(Modifier.size(box)) {
        val w = size.width * 0.86f
        val s = w / 56f
        translate((size.width - w) / 2, (size.height - 46f * s) / 2) {
            scale(s, s, pivot = Offset.Zero) {
                drawPath(folderBack, alpine.folderBack)
                drawPath(folderFront, alpine.folderFront)
            }
        }
    }
}

/* A tag as its dot and name, the way chips and lists show it. */
@Composable
fun TagPill(tag: com.hushos.app.data.Tag, selected: Boolean = false, onClick: (() -> Unit)? = null) {
    val alpine = Alpine.colors
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .background(if (selected) alpine.tint else Color.Transparent).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selected) Icon(Icons.Outlined.Check, null, tint = alpine.onTint, modifier = Modifier.size(16.dp)) else TagDot(tag.colour, 10.dp)
        Text(tag.name, style = MaterialTheme.typography.bodyLarge, color = if (selected) alpine.onTint else alpine.ink, modifier = Modifier.padding(start = AlpineSpace.S2))
    }
}
