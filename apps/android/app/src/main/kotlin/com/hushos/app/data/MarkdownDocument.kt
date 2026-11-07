package com.hushos.app.data

import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableBody
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/*
 * A Markdown file as data, for the viewer to draw: the web's rules (apps/web/src/lib/markdown.ts,
 * components/drive/rich-text.tsx) on commonmark-java. CommonMark plus GitHub's tables, task lists,
 * strikethrough and autolinks. Raw HTML in the document is dropped, not shown and never run. A
 * link is a link only to http, https or mailto, and only on a tap; an image is named, never
 * fetched, so opening a file loads nothing from anywhere. iOS's MarkdownDocument does the same.
 */
object MarkdownDocument {
    /* Past this the file opens as it did before (another app): the web's MARKDOWN_LIMIT. */
    const val LIMIT = 2L * 1024 * 1024

    private val parser = Parser.builder()
        .extensions(listOf(TablesExtension.create(), TaskListItemsExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()))
        .build()

    /* Opened in the Markdown viewer: the web's previewKind rule. */
    fun handles(name: String, mime: String?): Boolean {
        if (mime?.lowercase() == "text/markdown") return true
        val ext = name.substringAfterLast('.', "").lowercase()
        return name.contains('.') && ext in setOf("md", "markdown", "mdx")
    }

    fun parse(text: String): List<MdBlock> = blocks(parser.parse(text))

    private fun children(node: Node): Sequence<Node> = generateSequence(node.firstChild) { it.next }

    private fun blocks(parent: Node): List<MdBlock> = children(parent).mapNotNull(::block).toList()

    private fun block(node: Node): MdBlock? = when (node) {
        is Heading -> MdBlock.Heading(node.level, inline(node))
        is Paragraph -> MdBlock.Paragraph(inline(node))
        is BulletList -> MdBlock.ListBlock(ordered = false, start = 1, items = items(node))
        is OrderedList -> MdBlock.ListBlock(ordered = true, start = node.markerStartNumber ?: 1, items = items(node))
        is BlockQuote -> MdBlock.Quote(blocks(node))
        is FencedCodeBlock -> MdBlock.Code(node.info?.takeIf { it.isNotBlank() }, node.literal.removeSuffix("\n"))
        is IndentedCodeBlock -> MdBlock.Code(null, node.literal.removeSuffix("\n"))
        is ThematicBreak -> MdBlock.Rule
        is TableBlock -> table(node)
        // Raw HTML is dropped, as on the web: not drawn, not run, not shown as text.
        is HtmlBlock -> null
        else -> null
    }

    private fun items(list: Node): List<MdItem> = children(list).filterIsInstance<ListItem>().map { item ->
        val marker = children(item).filterIsInstance<TaskListItemMarker>().firstOrNull()
        MdItem(check = marker?.isChecked, blocks = blocks(item))
    }.toList()

    private fun table(table: TableBlock): MdBlock.Table {
        val rows = children(table).flatMap { section ->
            when (section) {
                is TableHead, is TableBody -> children(section).filterIsInstance<TableRow>()
                else -> emptySequence()
            }
        }.toList()
        val cells = rows.map { row -> children(row).filterIsInstance<TableCell>().toList() }
        val head = cells.firstOrNull().orEmpty()
        return MdBlock.Table(
            alignments = head.map {
                when (it.alignment) {
                    TableCell.Alignment.CENTER -> MdAlign.CENTER
                    TableCell.Alignment.RIGHT -> MdAlign.END
                    else -> MdAlign.START
                }
            },
            head = head.map(::inline),
            rows = cells.drop(1).map { row -> row.map(::inline) },
        )
    }

    /* A paragraph's runs: styled text, with images named in their own runs. */
    private fun inline(parent: Node): MdInline {
        val runs = mutableListOf<MdRun>()
        fun walk(node: Node, style: MdRun.Text) {
            fun add(text: String, extra: MdRun.Text = style) {
                val last = runs.lastOrNull()
                // Neighbours in the same style join, so a sentence stays one run.
                if (last is MdRun.Text && last.copy(text = "") == extra.copy(text = "")) runs[runs.lastIndex] = last.copy(text = last.text + text)
                else runs += extra.copy(text = text)
            }
            when (node) {
                is Text -> add(node.literal)
                is Code -> add(node.literal, style.copy(code = true))
                is SoftLineBreak -> add(" ")
                is HardLineBreak -> add("\n")
                // Dropped, as on the web.
                is HtmlInline, is TaskListItemMarker -> Unit
                is Image -> runs += MdRun.Image(alt = plain(node), source = node.destination)
                is Link -> children(node).forEach { walk(it, style.copy(link = safeLink(node.destination) ?: style.link)) }
                is Emphasis -> children(node).forEach { walk(it, style.copy(italic = true)) }
                is StrongEmphasis -> children(node).forEach { walk(it, style.copy(bold = true)) }
                is Strikethrough -> children(node).forEach { walk(it, style.copy(strike = true)) }
                else -> children(node).forEach { walk(it, style) }
            }
        }
        children(parent).forEach { walk(it, MdRun.Text("")) }
        return MdInline(runs)
    }

    private fun plain(node: Node): String = children(node).joinToString("") { child ->
        when (child) {
            is Text -> child.literal
            is Code -> child.literal
            else -> plain(child)
        }
    }

    /* A link the viewer may open on a tap: http, https or mailto only, as the web's sanitiser allows. */
    fun safeLink(destination: String?): String? {
        val target = destination?.trim() ?: return null
        val scheme = target.substringBefore(':', "").lowercase()
        return target.takeIf { scheme in setOf("http", "https", "mailto") && target.length > scheme.length + 1 }
    }
}

sealed interface MdBlock {
    data class Heading(val level: Int, val inline: MdInline) : MdBlock
    data class Paragraph(val inline: MdInline) : MdBlock
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<MdItem>) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Code(val language: String?, val text: String) : MdBlock
    data object Rule : MdBlock
    data class Table(val alignments: List<MdAlign>, val head: List<MdInline>, val rows: List<List<MdInline>>) : MdBlock
}

/* `check` is null for a plain item, true or false for a task list's box. */
data class MdItem(val check: Boolean?, val blocks: List<MdBlock>)

enum class MdAlign { START, CENTER, END }

data class MdInline(val runs: List<MdRun>) {
    val plainText: String get() = runs.joinToString("") { if (it is MdRun.Text) it.text else (it as MdRun.Image).alt }
}

sealed interface MdRun {
    data class Text(
        val text: String,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val code: Boolean = false,
        val strike: Boolean = false,
        val link: String? = null,
    ) : MdRun
    /* Named, never fetched: the viewer shows the alt text with an image mark, and the source only as text. */
    data class Image(val alt: String, val source: String?) : MdRun
}
