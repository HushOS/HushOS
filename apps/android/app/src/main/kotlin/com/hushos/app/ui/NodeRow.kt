package com.hushos.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AudioFile
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.outlined.Check
import androidx.compose.ui.Alignment
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import java.text.DateFormat
import java.util.Date

fun formatBytes(bytes: Long): String {
    // The web's rule, so a size reads the same everywhere: binary units, whole numbers from 100 up.
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KiB", "MiB", "GiB", "TiB")
    var value = bytes.toDouble()
    var unit = -1
    while (value >= 1024 && unit < units.size - 1) { value /= 1024; unit++ }
    return if (value >= 100) "${Math.round(value)} ${units[unit]}" else String.format(java.util.Locale.US, "%.1f %s", value, units[unit])
}

fun mimeOf(item: Opened): String? = item.metadata.mime ?: android.webkit.MimeTypeMap.getSingleton()
    .getMimeTypeFromExtension(item.name.substringAfterLast('.', "").lowercase())

/* One node in a list: a thumbnail or a type icon, the name, size and date. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NodeRow(
    model: DriveViewModel, state: DriveState, item: Opened, onClick: () -> Unit, onLongClick: () -> Unit, note: String? = null,
    /* Picked while selecting: the row takes the selection tint and its icon becomes a check, as Drive and Files do. */
    selected: Boolean = false,
    /* Something is being done to it (a restore or a delete in the trash): a ring until it is over. */
    working: Boolean = false,
) {
    LaunchedEffect(item.id) { model.thumbnail(item) }
    val thumbnail = state.thumbnails[item.id]
    val bitmap = remember(thumbnail) { thumbnail?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
    val subtitle = buildList {
        // A note (the trash's "Trashed Sep 23") takes the date's place.
        if (note != null) add(note) else item.modifiedMillis?.let { add(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it))) }
        item.size?.let { add(formatBytes(it)) }
        if (item.isFolder) add("Folder")
    }.joinToString(" · ")
    ListItem(
        headlineContent = { Text(item.name, maxLines = 1) },
        supportingContent = {
            androidx.compose.foundation.layout.Column {
                Text(subtitle, maxLines = 1, style = MaterialTheme.typography.bodySmall)
                val tags = state.tags.tagsOf(item.id)
                if (tags.isNotEmpty()) androidx.compose.foundation.layout.Row(Modifier.padding(top = 4.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp)) {
                    for (tag in tags.take(3)) TagPill(tag)
                    if (tags.size > 3) Text("+${tags.size - 3}", style = MaterialTheme.typography.labelSmall)
                }
            }
        },
        leadingContent = {
            if (selected) {
                Box(Modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(24.dp))
                }
            } else if (bitmap != null) {
                Image(bitmap.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)))
            } else Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                // Every leading image takes the same 40dp slot (thumbnail, icon or the selection check), so names never shift.
                val mime = mimeOf(item) ?: ""
                Icon(
                    when {
                        item.isFolder -> Icons.Outlined.Folder
                        mime.startsWith("image/") -> Icons.Outlined.Image
                        mime.startsWith("video/") -> Icons.Outlined.Movie
                        mime.startsWith("audio/") -> Icons.Outlined.AudioFile
                        mime == "application/pdf" -> Icons.Outlined.PictureAsPdf
                        mime.startsWith("text/") -> Icons.Outlined.Description
                        mime.contains("zip") || mime.contains("compressed") -> Icons.Outlined.Archive
                        else -> Icons.Outlined.InsertDriveFile
                    },
                    contentDescription = null,
                    tint = if (item.isFolder) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(32.dp),
                )
            }
        },
        trailingContent = {
            if (working) CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp)
            // Fetching to open: a small ring on the row, as the drives do, not a banner.
            else state.opening[item.id]?.let { fraction ->
                if (fraction > 0f) CircularProgressIndicator(progress = { fraction }, modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp)
                else CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp)
            }
        },
        colors = androidx.compose.material3.ListItemDefaults.colors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
        ),
        modifier = Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick),
    )
}

/* A tag as a small named pill in its colour. */
@Composable
fun TagPill(tag: com.hushos.app.data.Tag, selected: Boolean = false, onClick: (() -> Unit)? = null) {
    val base = tagColour(tag.colour)
    // Dark sheets need a lighter ink and a stronger wash, or a deep blue tag vanishes.
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val ink = if (dark) androidx.compose.ui.graphics.lerp(base, androidx.compose.ui.graphics.Color.White, 0.45f) else base
    Text(
        tag.name,
        style = MaterialTheme.typography.labelSmall,
        color = if (selected) androidx.compose.ui.graphics.Color.White else ink,
        modifier = Modifier
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .background(if (selected) base else ink.copy(alpha = if (dark) 0.22f else 0.14f), RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
