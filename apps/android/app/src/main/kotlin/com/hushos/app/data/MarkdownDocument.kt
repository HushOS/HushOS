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

    /*
     * How deep quotes and lists, and emphasis and links, are drawn as such; past this their words come as plain text, so
     * the steps below and the viewer's never recurse further. commonmark-java stops nesting blocks at 100 itself.
     */
    const val BLOCK_DEPTH = 16
    const val INLINE_DEPTH = 32

    fun parse(text: String): List<MdBlock> = try {
        blocks(parser.parse(text), 0)
    } catch (_: StackOverflowError) {
        // Nothing here should recurse that far; if the parser itself does, the file is shown as its text.
        listOf(MdBlock.Code(null, text))
    }

    private fun children(node: Node): Sequence<Node> = generateSequence(node.firstChild) { it.next }

    private fun blocks(parent: Node, depth: Int): List<MdBlock> = children(parent).mapNotNull { block(it, depth) }.toList()

    private fun block(node: Node, depth: Int): MdBlock? = if (depth >= BLOCK_DEPTH) flatText(node).takeIf { it.isNotEmpty() }?.let { MdBlock.Paragraph(MdInline(listOf(MdRun.Text(it)))) } else when (node) {
        is Heading -> MdBlock.Heading(node.level, inline(node))
        is Paragraph -> MdBlock.Paragraph(inline(node))
        is BulletList -> MdBlock.ListBlock(ordered = false, start = 1, items = items(node, depth))
        is OrderedList -> MdBlock.ListBlock(ordered = true, start = node.markerStartNumber ?: 1, items = items(node, depth))
        is BlockQuote -> MdBlock.Quote(blocks(node, depth + 1))
        is FencedCodeBlock -> MdBlock.Code(node.info?.takeIf { it.isNotBlank() }, node.literal.removeSuffix("\n"))
        is IndentedCodeBlock -> MdBlock.Code(null, node.literal.removeSuffix("\n"))
        is ThematicBreak -> MdBlock.Rule
        is TableBlock -> table(node)
        // Raw HTML is dropped, as on the web: not drawn, not run, not shown as text.
        is HtmlBlock -> null
        else -> null
    }

    private fun items(list: Node, depth: Int): List<MdItem> = children(list).filterIsInstance<ListItem>().map { item ->
        val marker = children(item).filterIsInstance<TaskListItemMarker>().firstOrNull()
        MdItem(check = marker?.isChecked, blocks = blocks(item, depth + 1))
    }.toList()

    /* The words under a node, walked with a stack of our own, not recursion: what a too-deep part shows. Raw HTML stays out. */
    internal fun flatText(root: Node): String {
        val words = StringBuilder()
        val stack = ArrayDeque<Node>().apply { addLast(root) }
        while (stack.isNotEmpty()) {
            when (val node = stack.removeLast()) {
                is Text -> words.append(node.literal)
                is Code -> words.append(node.literal)
                is FencedCodeBlock -> words.append(node.literal)
                is IndentedCodeBlock -> words.append(node.literal)
                is SoftLineBreak, is HardLineBreak -> words.append(' ')
                is HtmlInline, is HtmlBlock -> Unit
                else -> {
                    // Blocks are kept apart by a space; children go on last-first, so they come off in order.
                    if (node is org.commonmark.node.Block && words.isNotEmpty() && words.last() != ' ') words.append(' ')
                    children(node).toList().asReversed().forEach(stack::addLast)
                }
            }
        }
        return words.toString()
    }

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
        // The run being written: neighbours in the same style join, so a sentence stays one run. A builder, not a
        // string copied whole for each piece: a long paragraph of short lines would be quadratic.
        var current: MdRun.Text? = null
        val text = StringBuilder()
        fun flush() {
            current?.let { if (text.isNotEmpty()) runs += it.copy(text = text.toString()) }
            current = null
            text.setLength(0)
        }
        fun walk(node: Node, style: MdRun.Text, depth: Int) {
            fun add(piece: String, extra: MdRun.Text = style) {
                if (current != extra) flush()
                current = extra
                text.append(piece)
            }
            if (depth >= INLINE_DEPTH) { add(flatText(node)); return }
            when (node) {
                is Text -> add(node.literal)
                is Code -> add(node.literal, style.copy(code = true))
                is SoftLineBreak -> add(" ")
                is HardLineBreak -> add("\n")
                // Dropped, as on the web.
                is HtmlInline, is TaskListItemMarker -> Unit
                is Image -> { flush(); runs += MdRun.Image(alt = plain(node), source = node.destination) }
                is Link -> children(node).forEach { walk(it, style.copy(link = safeLink(node.destination) ?: style.link), depth + 1) }
                is Emphasis -> children(node).forEach { walk(it, style.copy(italic = true), depth + 1) }
                is StrongEmphasis -> children(node).forEach { walk(it, style.copy(bold = true), depth + 1) }
                is Strikethrough -> children(node).forEach { walk(it, style.copy(strike = true), depth + 1) }
                else -> children(node).forEach { walk(it, style, depth + 1) }
            }
        }
        children(parent).forEach { walk(it, MdRun.Text(""), 0) }
        flush()
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
