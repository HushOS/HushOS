package com.hushos.app.ui

import androidx.compose.runtime.setValue
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.em
import com.hushos.app.data.SessionUser
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineSpace

/*
 * The furniture Home and Files share, as the board draws it: the search bar, the
 * avatar, chips, subheaders, banners, the paste bar, empty and loading states.
 */

/* A raised surface: a shadow in light and dark, none in high contrast, where the edge turns solid instead. */
@Composable
fun Modifier.raised(shape: Shape, elevation: Dp = 3.dp): Modifier {
    val alpine = Alpine.colors
    return (if (alpine.high) this else this.shadow(elevation, shape, clip = false)).border(1.dp, alpine.edge, shape)
}

/* Home's header: a pill that opens search. */
@Composable
fun SearchPill(placeholder: String, onClick: () -> Unit, trailing: (@Composable () -> Unit)? = null) {
    val alpine = Alpine.colors
    Row(
        Modifier.padding(horizontal = AlpineSpace.S4).fillMaxWidth().height(56.dp).clip(CircleShape).background(alpine.fill)
            // In high contrast the fill alone hardly shows against the ground; the field's outline marks it.
            .then(if (alpine.high) Modifier.border(1.dp, alpine.field, CircleShape) else Modifier)
            .clickable(onClick = onClick, role = Role.Button).padding(start = AlpineSpace.S4, end = AlpineSpace.S1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, null, tint = alpine.ink)
        Text(placeholder, color = alpine.inkMuted, style = MaterialTheme.typography.bodyLarge, maxLines = 1, modifier = Modifier.weight(1f).padding(start = AlpineSpace.S3))
        trailing?.invoke()
    }
}

/*
 * A filter chip: outlined at rest, tint and a check when on. Tint alone never
 * carries the state, so the check is always there when it is selected.
 */
@Composable
fun AlpineChip(label: String, selected: Boolean, onClick: () -> Unit, leading: (@Composable () -> Unit)? = null) {
    val alpine = Alpine.colors
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.heightIn(min = 32.dp).clip(shape)
            .then(if (selected) Modifier.background(alpine.tint) else Modifier.border(1.dp, alpine.field, shape))
            .clickable(onClick = onClick, role = Role.Checkbox).semantics { this.selected = selected }
            .padding(horizontal = AlpineSpace.S3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2),
    ) {
        if (selected) Icon(Icons.Outlined.Check, null, tint = alpine.onTint, modifier = Modifier.size(18.dp)) else leading?.invoke()
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) alpine.onTint else alpine.ink, maxLines = 1)
    }
}

/* A tag's colour as a small dot. */
@Composable
fun TagDot(colour: String, size: Dp = 8.dp, dark: Boolean = false) {
    // In the dark a fixed colour lightens so a deep one stays visible, as on iOS; the theme's own
    // colours (blue, ink) and yellow already have a dark value.
    val base = tagColour(colour)
    val shown = if (dark && colour !in setOf("blue", "ink", "yellow")) androidx.compose.ui.graphics.lerp(base, Color.White, 0.35f) else base
    Box(Modifier.size(size).background(shown, CircleShape))
}

/* A section label over a list, in the primary colour, as Material lists head their groups. */
@Composable
fun Subheader(text: String, compact: Boolean = false, action: (@Composable RowScope.() -> Unit)? = null) {
    // Compact: the label alone with a little room, for Home's stacked sections.
    val size = if (compact) Modifier.padding(top = AlpineSpace.S1, bottom = AlpineSpace.S1) else Modifier.height(48.dp)
    Row(Modifier.fillMaxWidth().then(size).padding(start = AlpineSpace.S4, end = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
        action?.invoke(this)
    }
}

/* Kept from today's line, restyled as a quiet strip in the list rather than a bar across the top. */
@Composable
fun OfflineCapsule(modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    Row(
        modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S2).fillMaxWidth()
            .background(alpine.ink.copy(alpha = if (alpine.high) 0.1f else 0.06f), RoundedCornerShape(12.dp))
            .padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.CloudOff, null, tint = alpine.inkMuted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(AlpineSpace.S3))
        Text("You’re offline. Showing what’s on this phone.", style = MaterialTheme.typography.bodyMedium, color = alpine.ink)
    }
}

/* Who can open everything in a shared folder, said once at its top, with the way to change it. */
@Composable
fun AccessBanner(text: String, onManage: (() -> Unit)?, linked: Boolean = false) {
    val alpine = Alpine.colors
    Row(
        Modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S2).fillMaxWidth()
            .background(alpine.card, RoundedCornerShape(AlpineRadius.Card))
            .then(if (alpine.high) Modifier.border(1.dp, alpine.edge, RoundedCornerShape(AlpineRadius.Card)) else Modifier)
            .padding(start = AlpineSpace.S4, end = AlpineSpace.S1, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A folder anyone with its link can open: the banner's icon is the link, in Hush blue.
        Icon(if (linked) Icons.Outlined.Link else Icons.Outlined.Group, null, tint = alpine.primary, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = alpine.ink, modifier = Modifier.weight(1f).padding(horizontal = AlpineSpace.S3, vertical = AlpineSpace.S2))
        if (onManage != null) TextButton(onClick = onManage) { Text("Manage") }
    }
}

/* What the clipboard holds, at the bottom of a folder, and why it cannot go here when it cannot. */
@Composable
fun PasteBar(text: String, reason: String?, onPaste: () -> Unit, onClear: () -> Unit, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    val shape = RoundedCornerShape(AlpineRadius.Card)
    Row(
        modifier.padding(horizontal = AlpineSpace.S3, vertical = AlpineSpace.S3).fillMaxWidth().heightIn(min = 64.dp)
            .raised(shape).background(alpine.tint.copy(alpha = if (alpine.high) 1f else 0.4f).compositeOver(alpine.surface), shape)
            .padding(start = AlpineSpace.S4, end = AlpineSpace.S1, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.ContentPaste, null, tint = alpine.inkMuted)
        Column(Modifier.weight(1f).padding(horizontal = AlpineSpace.S3)) {
            Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (reason != null) alpine.inkMuted else alpine.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            reason?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1) }
        }
        if (reason == null) TextButton(onClick = onPaste) { Text("Paste") }
        IconButton(onClick = onClear) { Icon(Icons.Outlined.Close, "Clear clipboard") }
    }
}

/* An empty, failed or offline state: a quiet mark, a short title, one line, and what to do. */
@Composable
fun EmptyState(title: String, body: String? = null, icon: ImageVector? = null, danger: Boolean = false, modifier: Modifier = Modifier, actions: (@Composable () -> Unit)? = null) {
    val alpine = Alpine.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        icon?.let {
            Box(Modifier.padding(bottom = AlpineSpace.S4).size(56.dp).background(if (danger) alpine.dangerSoft else alpine.tint, CircleShape), contentAlignment = Alignment.Center) {
                Icon(it, null, tint = if (danger) alpine.danger else alpine.onTint)
            }
        }
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, color = alpine.ink)
        body?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = AlpineSpace.S2)) }
        actions?.let { Column(Modifier.padding(top = AlpineSpace.S6).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2), horizontalAlignment = Alignment.CenterHorizontally) { it() } }
    }
}

/* Placeholder rows while a folder loads for the first time. */
@Composable
fun SkeletonRows(rows: Int = 7) {
    val alpine = Alpine.colors
    val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(0.05f, 0.1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse")
    Column(Modifier.semantics { contentDescription = "Loading" }) {
        repeat(rows) { i ->
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(36.dp).background(alpine.ink.copy(alpha = pulse), RoundedCornerShape(8.dp)))
                Column(Modifier.padding(start = AlpineSpace.S4).weight(1f), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    Box(Modifier.fillMaxWidth((70 - (i * 13) % 30) / 100f).height(12.dp).background(alpine.ink.copy(alpha = pulse), CircleShape))
                    Box(Modifier.fillMaxWidth(0.34f).height(10.dp).background(alpine.ink.copy(alpha = pulse * 0.7f), CircleShape))
                }
            }
        }
    }
}

/* The app's current notice, drawn by whatever is on top (a sheet is its own window). */
val LocalNotice = androidx.compose.runtime.compositionLocalOf<@Composable () -> Unit> { {} }

/* How tall the notice and transfer bars at the foot are right now: the + button and the lists' ends move up by it, as Material lifts a FAB over a snackbar. */
val LocalFootBars = androidx.compose.runtime.compositionLocalOf { 0.dp }

/*
 * A modal bottom sheet on the white surface, as the board draws sheets. Inside it
 * Material's `surface` is the sheet's own colour, so rows (ListItem paints itself
 * in `surface`) sit on the sheet rather than banding it with the screen's ground.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun Sheet(onDismissRequest: () -> Unit, full: Boolean = false, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val alpine = Alpine.colors
    // `full`: a sheet with its own header and long content opens at full height, not half way.
    val sheetState = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = full)
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismissRequest, sheetState = sheetState, containerColor = alpine.surface) {
        val notice = LocalNotice.current
        Box {
            MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(surface = alpine.surface)) {
                Column { content() }
            }
            Box(Modifier.align(Alignment.BottomCenter)) { notice() }
        }
    }
}

/*
 * The one header every destination and folder uses: the title on the left and
 * its actions on the right, on a single row right under the status bar. A tab's
 * title is large; a folder (or any pushed screen) has a back arrow and a smaller
 * title. Never an actions row above the title.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun DestinationBar(
    title: String,
    onBack: (() -> Unit)? = null,
    scrollBehavior: androidx.compose.material3.TopAppBarScrollBehavior? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val alpine = Alpine.colors
    androidx.compose.material3.TopAppBar(
        title = {
            Text(
                title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = if (onBack == null) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.titleLarge,
            )
        },
        navigationIcon = { onBack?.let { IconButton(onClick = it) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } } },
        actions = actions,
        scrollBehavior = scrollBehavior,
        // A tab's large title sits about 10dp under the status bar, not centred in a 64dp toolbar.
        expandedHeight = if (onBack == null) 52.dp else androidx.compose.material3.TopAppBarDefaults.TopAppBarExpandedHeight,
        // Scrolling (or pulling to refresh) must not tint the bar: the screen stays one colour.
        colors = androidx.compose.material3.TopAppBarDefaults.topAppBarColors(containerColor = alpine.ground, scrolledContainerColor = alpine.ground),
    )
}

/* A plain meter, as the board draws storage: a rounded track and its filled part, no stop dot, no gap. */
@Composable
fun Meter(fraction: Float, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(alpine.ink.copy(alpha = if (alpine.high) 0.2f else 0.1f))) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(6.dp).clip(CircleShape).background(alpine.primary))
    }
}

/*
 * A small icon set into a subtitle (the link, the phone for "kept on this phone"): every one the
 * same size as the text it sits in (so it scales with the font), the same Material outlined
 * stroke, centred on the line, and followed by the same single space.
 */
fun subtitleGlyph(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color) = androidx.compose.foundation.text.InlineTextContent(
    androidx.compose.ui.text.Placeholder(1.em, 1.em, androidx.compose.ui.text.PlaceholderVerticalAlign.TextCenter),
) { Icon(icon, null, tint = tint, modifier = Modifier.fillMaxSize()) }

/*
 * A line that may say "Anyone with the link": the text in its usual colour, and the link icon in
 * Hush blue before it. People-only access gets no icon.
 */
@Composable
fun AccessText(
    text: String, linked: Boolean, modifier: Modifier = Modifier,
    color: Color = Alpine.colors.inkMuted, style: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyMedium,
    fontWeight: androidx.compose.ui.text.font.FontWeight? = null, maxLines: Int = 1, textAlign: androidx.compose.ui.text.style.TextAlign? = null,
) {
    val annotated = androidx.compose.ui.text.buildAnnotatedString {
        if (linked) { appendInlineContent("link", "\u200B"); append(" ") }
        append(text)
    }
    Text(annotated, modifier = modifier, style = style, color = color, fontWeight = fontWeight, maxLines = maxLines, textAlign = textAlign,
        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, inlineContent = mapOf("link" to subtitleGlyph(Icons.Outlined.Link, Alpine.colors.primary)))
}

/*
 * A folder known only by its saved id (after the system restarted the app): found again from the
 * catalogue, then shown; while it is found the screen says it is opening. Gone (trashed, unshared):
 * `onGone`, so the screen goes back rather than showing nothing.
 */
@Composable
fun RestoredFolder(model: DriveViewModel, id: String, onGone: () -> Unit, content: @Composable (com.hushos.app.data.Opened) -> Unit) {
    val known = model.item(id)
    val found by androidx.compose.runtime.produceState(known, id) { if (value == null) value = model.find(id) ?: run { onGone(); null } }
    val folder = known ?: found
    if (folder != null) content(folder) else OpeningScreen()
}

/*
 * Loading rows while a folder is found again after a restart. Names are sealed, so none is
 * written to the saved state; the bar says "Opening…" until the folder is known.
 */
@Composable
fun OpeningScreen() {
    Column(Modifier.fillMaxSize()) { DestinationBar("Opening…"); SkeletonRows(6) }
}

/*
 * An item a screen has open (a sheet's target), saved by id only, never its name, and found
 * again from the catalogue after the system restarts the app. Gone by then: nothing is open.
 */
@Composable
fun rememberSavedItem(model: DriveViewModel): androidx.compose.runtime.MutableState<com.hushos.app.data.Opened?> {
    var id by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf<String?>(null) }
    val item = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(id?.let { model.item(it) }) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        val saved = id
        if (item.value == null && saved != null) item.value = model.find(saved)
        androidx.compose.runtime.snapshotFlow { item.value?.id }.collect { id = it }
    }
    return item
}

/*
 * The share sheet for something HushOS hands out (a file, a link, the recovery kit), without
 * Save to HushOS in it: saving HushOS's own file back into HushOS is never what's meant, and a
 * recovery kit must never land in the drive it unlocks.
 */
fun shareChooser(context: android.content.Context, send: android.content.Intent, title: String): android.content.Intent =
    android.content.Intent.createChooser(send, title)
        .putExtra(android.content.Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(context, com.hushos.app.ShareActivity::class.java)))

/*
 * A page of the signed-in server's website (privacy policy, terms), in a Custom Tab over the
 * app, or the browser when no browser offers one.
 */
fun openWebPage(context: android.content.Context, url: String) {
    val uri = android.net.Uri.parse(url)
    runCatching { androidx.browser.customtabs.CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri) }
        .recoverCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/* The server's own privacy policy and terms (hushos.com's by default); app=1 drops the site's links to plans. */
fun privacyUrl(origin: String) = origin.trimEnd('/') + "/privacy?app=1"
fun termsUrl(origin: String) = origin.trimEnd('/') + "/terms?app=1"
