package com.hushos.app.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.hushos.app.data.MarkdownDocument
import com.hushos.app.data.MdAlign
import com.hushos.app.data.MdBlock
import com.hushos.app.data.MdInline
import com.hushos.app.data.MdRun
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * A Markdown file opened in the app: its name, the decrypted copy, its type for Open with, and the item and workspace
 * it came from, so a family's clear-out (FamiliesModel.clear) closes it with the rest of what the family showed.
 */
data class Reading(val name: String, val uri: Uri, val mime: String?, val node: String? = null, val workspace: String? = null)

/*
 * A Markdown file, drawn as a document rather than handed to whichever app claims text: the
 * blocks MarkdownDocument reads (the web's rules: raw HTML dropped, links to http, https or mailto
 * only and only on a tap, images named and never fetched) in HushOS's type and colours. Text can
 * be selected; Open with hands the file to another app as before. iOS's MarkdownView draws the same.
 */
@Composable
fun MarkdownViewer(reading: Reading, close: () -> Unit, openElsewhere: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var blocks by remember(reading.uri) { mutableStateOf<List<MdBlock>?>(null) }
    LaunchedEffect(reading.uri) {
        // Read and parsed off the main thread: a long file shouldn't hold up the bar.
        blocks = withContext(Dispatchers.IO) {
            val text = runCatching { context.contentResolver.openInputStream(reading.uri)?.use { it.readBytes().decodeToString() } }.getOrNull()
            MarkdownDocument.parse(text.orEmpty())
        }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Scaffold(
            containerColor = alpine.ground,
            topBar = {
                DestinationBar(reading.name, onBack = close) {
                    IconButton(onClick = openElsewhere) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, "Open with") }
                }
            },
        ) { padding ->
            val shown = blocks
            if (shown == null) {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
                    CircularProgressIndicator(color = alpine.primary, modifier = Modifier.padding(top = 48.dp))
                }
            } else {
                // Filling the readable width, not shrinking to its widest block: a file of short lines stays at the left.
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding).readableWidth(720.dp).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    itemsIndexed(shown) { _, block -> SelectionContainer { MarkdownBlockView(block) } }
                }
            }
        }
    }
}

@Composable
private fun MarkdownBlockView(block: MdBlock, muted: Boolean = false) {
    val alpine = Alpine.colors
    val type = MaterialTheme.typography
    // A quote's words are muted, all the way down.
    val ink = if (muted) alpine.inkMuted else alpine.ink
    when (block) {
        is MdBlock.Heading -> MarkdownText(
            block.inline,
            when (block.level) {
                1 -> type.headlineMedium.copy(fontWeight = FontWeight.Bold)
                2 -> type.headlineSmall.copy(fontWeight = FontWeight.Bold)
                3 -> type.titleLarge.copy(fontWeight = FontWeight.SemiBold)
                else -> type.titleMedium.copy(fontWeight = FontWeight.SemiBold)
            },
            ink,
            Modifier.padding(top = if (block.level <= 2) 8.dp else 0.dp).semantics { heading() },
        )
        is MdBlock.Paragraph -> MarkdownText(block.inline, type.bodyLarge, ink)
        is MdBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            block.items.forEachIndexed { index, item ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // A continued item (the rest of the one before, cut off with its list) keeps the indent, unmarked.
                    Box(if (item.continued) Modifier.alpha(0f).clearAndSetSemantics {} else Modifier) { when {
                        item.check != null -> Icon(
                            if (item.check) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank,
                            if (item.check) "Done" else "Not done",
                            tint = if (item.check) alpine.primary else alpine.inkMuted,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                        block.ordered -> Text("${block.start + index}.", style = type.bodyLarge.copy(fontFeatureSettings = "tnum"), color = alpine.inkMuted)
                        else -> Text("•", style = type.bodyLarge, color = alpine.inkMuted)
                    } }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { item.blocks.forEach { MarkdownBlockView(it, muted) } }
                }
            }
        }
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(alpine.rule, RoundedCornerShape(1.5.dp)))
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { block.blocks.forEach { MarkdownBlockView(it, muted = true) } }
        }
        is MdBlock.Code -> {
            // Scrolled sideways like code, unless a line is so long that its width can't be laid out (Compose's limit): then it wraps.
            val wrap = remember(block.text) { block.text.lineSequence().any { it.length > LONGEST_UNWRAPPED } }
            Box(Modifier.fillMaxWidth().background(alpine.surface, RoundedCornerShape(12.dp)).then(if (wrap) Modifier else Modifier.horizontalScroll(rememberScrollState()))) {
                Text(block.text, style = type.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = ink, softWrap = wrap, modifier = Modifier.padding(12.dp))
            }
        }
        MdBlock.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 8.dp).height(1.dp).background(alpine.rule))
        is MdBlock.Table -> Box(Modifier.fillMaxWidth().background(alpine.surface, RoundedCornerShape(12.dp)).horizontalScroll(rememberScrollState())) {
            MarkdownTable(block, ink)
        }
    }
}

/*
 * A table's own grid: each column as wide as its widest cell, each row as tall as its tallest, a rule under the head.
 * Measured as one grid (not column by column), so a cell that wraps keeps its row level with the cells beside it.
 */
@Composable
private fun MarkdownTable(table: MdBlock.Table, ink: androidx.compose.ui.graphics.Color) {
    val alpine = Alpine.colors
    val type = MaterialTheme.typography
    val columns = maxOf(table.head.size, table.rows.maxOfOrNull { it.size } ?: 0)
    if (columns == 0) return
    fun align(column: Int) = when (table.alignments.getOrNull(column)) {
        MdAlign.CENTER -> TextAlign.Center
        MdAlign.END -> TextAlign.End
        else -> TextAlign.Start
    }
    val rows = listOf(table.head) + table.rows
    val density = androidx.compose.ui.platform.LocalDensity.current
    val gap = with(density) { 8.dp.roundToPx() }
    val rule = with(density) { 1.dp.roundToPx() }
    val columnMax = with(density) { 320.dp.roundToPx() }
    androidx.compose.ui.layout.Layout(
        content = {
            rows.forEachIndexed { r, row ->
                for (column in 0 until columns) {
                    val style = if (r == 0) type.bodyMedium.copy(fontWeight = FontWeight.SemiBold) else type.bodyMedium
                    MarkdownText(row.getOrNull(column) ?: MdInline(emptyList()), style.copy(textAlign = align(column)), ink, Modifier.padding(horizontal = 8.dp))
                }
            }
            // The rule under the head, as wide as the grid.
            Box(Modifier.background(alpine.rule))
        },
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp),
    ) { measurables, _ ->
        val cells = measurables.dropLast(1)
        // A column is as wide as its widest cell up to 320dp, and wraps past that; and the whole grid stays far inside what
        // Compose can lay out (a 300 KB cell's width can't be represented, and threw).
        val widest = minOf(columnMax, MAX_GRID_PX / columns)
        val widths = IntArray(columns) { c -> rows.indices.maxOf { r -> cells[r * columns + c].maxIntrinsicWidth(androidx.compose.ui.unit.Constraints.Infinity) }.coerceIn(1, maxOf(1, widest)) }
        val placed = cells.mapIndexed { i, cell -> cell.measure(androidx.compose.ui.unit.Constraints.fixedWidth(widths[i % columns])) }
        val heights = IntArray(rows.size) { r -> (0 until columns).maxOf { c -> placed[r * columns + c].height } }
        val width = widths.sum()
        val divider = measurables.last().measure(androidx.compose.ui.unit.Constraints.fixed(width, rule))
        // The head, the rule half a gap below it, then the rows a gap apart; one pass decides where, both to size and to place.
        fun rowTops(): IntArray {
            var y = 0
            return IntArray(rows.size) { r ->
                if (r == 1) y += gap + rule else if (r > 1) y += gap
                y.also { y += heights[r] }
            }
        }
        val tops = rowTops()
        val height = tops.last() + heights.last()
        layout(width, height) {
            rows.indices.forEach { r ->
                var x = 0
                for (c in 0 until columns) { placed[r * columns + c].placeRelative(x, tops[r]); x += widths[c] }
            }
            if (rows.size > 1) divider.placeRelative(0, heights[0] + gap / 2)
        }
    }
}

/* A run of styled text; a link opens on a tap; an image is its mark and its words, never the picture. */
@Composable
private fun MarkdownText(inline: MdInline, style: TextStyle, color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val linkStyle = TextLinkStyles(SpanStyle(color = alpine.primary, textDecoration = TextDecoration.Underline))
    val text: AnnotatedString = remember(inline, alpine) {
        buildAnnotatedString {
            inline.runs.forEach { run ->
                when (run) {
                    is MdRun.Text -> {
                        val span = SpanStyle(
                            fontWeight = if (run.bold) FontWeight.Bold else null,
                            fontStyle = if (run.italic) FontStyle.Italic else null,
                            fontFamily = if (run.code) FontFamily.Monospace else null,
                            background = if (run.code) alpine.fill else androidx.compose.ui.graphics.Color.Unspecified,
                            textDecoration = if (run.strike) TextDecoration.LineThrough else null,
                        )
                        val link = run.link
                        if (link != null) {
                            withLink(LinkAnnotation.Url(link, linkStyle) { openMarkdownLink(context, link) }) { withStyle(span) { append(run.text) } }
                        } else withStyle(span) { append(run.text) }
                    }
                    is MdRun.Image -> {
                        val link = run.link
                        val name: AnnotatedString.Builder.() -> Unit = {
                            appendInlineContent(IMAGE_MARK, "[image]")
                            append(" ")
                            append(run.alt.ifBlank { "Image" })
                        }
                        if (link != null) withLink(LinkAnnotation.Url(link, linkStyle) { openMarkdownLink(context, link) }) { name() }
                        else withStyle(SpanStyle(color = alpine.inkMuted)) { name() }
                    }
                }
            }
        }
    }
    val inlineContent: Map<String, InlineTextContent> = remember(alpine) { mapOf(IMAGE_MARK to subtitleGlyph(Icons.Outlined.Image, alpine.inkMuted)) }
    Text(text, style = style, color = color, inlineContent = inlineContent, modifier = modifier)
}

private const val IMAGE_MARK = "image"

/* A code line longer than this wraps instead of scrolling sideways; a grid never gets wider than this many pixels. */
private const val LONGEST_UNWRAPPED = 1000
private const val MAX_GRID_PX = 100_000

/* A web link in a Custom Tab over the app; mail in the mail app. Nothing else is ever a link (MarkdownDocument.safeLink). */
private fun openMarkdownLink(context: android.content.Context, link: String) {
    if (link.startsWith("mailto:", ignoreCase = true)) {
        runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_SENDTO, Uri.parse(link)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    } else openWebPage(context, link)
}
