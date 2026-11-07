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

    /*
     * The most one block holds before it is cut into consecutive ones: the viewer lays out a block at a time and only
     * those on screen, and a 1.5 MB paragraph as one text took the UI thread for half a minute. A table chunk repeats
     * its head. iOS cuts at the same places.
     */
    const val PARAGRAPH_CHARS = 4000
    const val CODE_LINES = 200
    const val TABLE_ROWS = 200
    /* A table cell or an image's alt text past this is shortened with "…": neither can be cut into pieces, and Open with shows it whole. */
    const val CELL_CHARS = 2000
    /*
     * The most a list or quote holds before it is cut into consecutive ones, in weight (one per block, one per table row,
     * one per CHARS_PER_WEIGHT characters): its children are laid out together, so 100,000 `- item` lines as one list
     * froze the viewer as one paragraph had. An item too heavy for one piece goes on in the next without its marker.
     */
    const val BLOCK_WEIGHT = 200
    /*
     * A table piece holds at most TABLE_CELLS cells (TABLE_ROWS rows of a narrow table, fewer of a wide one), and a table
     * shows at most TABLE_COLUMNS columns, the rest standing as one "…" column: its grid is laid out whole, and a 9 KB
     * file of 1,000 empty columns makes hundreds of thousands of cells. An image counts as at least IMAGE_CHARS, so a
     * paragraph of empty-alt images (each drawn as a mark and a word) is cut too.
     */
    const val TABLE_CELLS = 4000
    const val TABLE_COLUMNS = 50
    const val IMAGE_CHARS = 20
    private const val CHARS_PER_WEIGHT = 200

    fun parse(text: String): List<MdBlock> = try {
        blocks(parser.parse(text), 0)
    } catch (_: StackOverflowError) {
        // Nothing here should recurse that far; if the parser itself does, the file is shown as its text.
        cut(MdBlock.Code(null, text))
    } catch (_: RuntimeException) {
        // The parser refuses some files outright (a table of more than a million cells, from 14 KB): shown as text too.
        cut(MdBlock.Code(null, text))
    }

    private fun children(node: Node): Sequence<Node> = generateSequence(node.firstChild) { it.next }

    private fun blocks(parent: Node, depth: Int): List<MdBlock> = children(parent).mapNotNull { block(it, depth) }.flatMap(::cut).toList()

    /* A block too big to lay out at once, as consecutive blocks of the same kind. */
    internal fun cut(block: MdBlock): List<MdBlock> = when (block) {
        is MdBlock.Paragraph -> cutInline(block.inline).map { MdBlock.Paragraph(it) }
        is MdBlock.Heading -> cutInline(block.inline).map { MdBlock.Heading(block.level, it) }
        is MdBlock.Quote -> if (weight(block) <= BLOCK_WEIGHT) listOf(block) else pack(block.blocks, BLOCK_WEIGHT - 1).map { MdBlock.Quote(it) }
        is MdBlock.ListBlock -> if (weight(block) <= BLOCK_WEIGHT) listOf(block) else cutList(block)
        is MdBlock.Code -> cutCode(block.text).map { MdBlock.Code(block.language, it) }
        is MdBlock.Table -> {
            val narrow = narrow(block)
            val short = narrow.copy(head = narrow.head.map(::shortCell), rows = narrow.rows.map { row -> row.map(::shortCell) })
            val rows = minOf(TABLE_ROWS, maxOf(1, TABLE_CELLS / maxOf(1, short.head.size)))
            if (short.rows.size <= rows) listOf(short) else short.rows.chunked(rows).map { short.copy(rows = it) }
        }
        else -> listOf(block)
    }

    /* At most TABLE_COLUMNS columns: past that, one "…" column stands for the rest (Open with shows the file whole). */
    private fun narrow(table: MdBlock.Table): MdBlock.Table {
        if (table.head.size <= TABLE_COLUMNS) return table
        val more = MdInline(listOf(MdRun.Text("…")))
        fun keep(cells: List<MdInline>) = cells.take(TABLE_COLUMNS) + more
        return MdBlock.Table(table.alignments.take(TABLE_COLUMNS) + MdAlign.START, keep(table.head), table.rows.map(::keep))
    }

    /* How much laying a block out costs, roughly: see BLOCK_WEIGHT. Its children were cut first, so each is bounded. */
    internal fun weight(block: MdBlock): Int = when (block) {
        is MdBlock.Paragraph -> 1 + block.inline.length / CHARS_PER_WEIGHT
        is MdBlock.Heading -> 1 + block.inline.length / CHARS_PER_WEIGHT
        is MdBlock.Code -> 1 + block.text.length / CHARS_PER_WEIGHT
        is MdBlock.Table -> 1 + (block.rows.size + 1) * block.head.size / 20
        is MdBlock.Quote -> 1 + block.blocks.sumOf(::weight)
        is MdBlock.ListBlock -> 1 + block.items.sumOf(::weight)
        MdBlock.Rule -> 1
    }

    private fun weight(item: MdItem): Int = 1 + item.blocks.sumOf(::weight)

    /* Consecutive blocks in groups of at most `room` (a heavier block alone): the room a container leaves past its own 1. */
    private fun pack(blocks: List<MdBlock>, room: Int): List<List<MdBlock>> {
        val groups = mutableListOf<List<MdBlock>>()
        var current = mutableListOf<MdBlock>()
        var total = 0
        for (block in blocks) {
            val each = weight(block)
            if (current.isNotEmpty() && total + each > room) { groups += current; current = mutableListOf(); total = 0 }
            current += block
            total += each
        }
        if (current.isNotEmpty()) groups += current
        return groups
    }

    /*
     * A list in pieces of at most BLOCK_WEIGHT, numbered on. A heavy item's blocks go into several items, the later ones
     * `continued` (no marker); greedy packing never lets two parts of one item share a piece, so a continued item only
     * ever comes first, and each piece's items number from its start.
     */
    private fun cutList(list: MdBlock.ListBlock): List<MdBlock> {
        val parts = list.items.flatMap { item ->
            if (weight(item) <= BLOCK_WEIGHT - 1) listOf(item)
            else pack(item.blocks, BLOCK_WEIGHT - 2).mapIndexed { index, blocks -> if (index == 0) item.copy(blocks = blocks) else MdItem(null, blocks, continued = true) }
        }
        val pieces = mutableListOf<MdBlock>()
        var current = mutableListOf<MdItem>()
        var total = 0
        var number = list.start
        var start = number
        for (part in parts) {
            val each = weight(part)
            if (current.isNotEmpty() && total + each > BLOCK_WEIGHT - 1) { pieces += list.copy(start = start, items = current); current = mutableListOf(); total = 0 }
            if (current.isEmpty()) start = if (part.continued) number - 1 else number
            current += part
            total += each
            if (!part.continued) number++
        }
        if (current.isNotEmpty()) pieces += list.copy(start = start, items = current)
        return pieces
    }

    /* Code in pieces of at most CODE_LINES lines and PARAGRAPH_CHARS characters; a longer line is cut where it must be. */
    private fun cutCode(text: String): List<String> {
        val pieces = mutableListOf<String>()
        val piece = StringBuilder()
        var lines = 0
        fun close() { if (lines > 0) pieces += piece.toString(); piece.setLength(0); lines = 0 }
        for (line in text.split('\n')) {
            for (segment in if (line.isEmpty()) listOf("") else pieces(line, PARAGRAPH_CHARS)) {
                if (lines > 0 && (lines >= CODE_LINES || piece.length + 1 + segment.length > PARAGRAPH_CHARS)) close()
                if (lines > 0) piece.append('\n')
                piece.append(segment)
                lines++
            }
        }
        close()
        return pieces
    }

    /*
     * Where a hard cut at `end` may fall: never between the two halves of a character outside the BMP (an emoji), which
     * would show as two broken halves in separate blocks.
     */
    private fun safeEnd(text: String, end: Int): Int =
        if (end in 1 until text.length && Character.isHighSurrogate(text[end - 1]) && Character.isLowSurrogate(text[end])) end - 1 else end

    /* A long line in pieces of at most `size`, cut at safe ends. */
    private fun pieces(line: String, size: Int): List<String> {
        val parts = mutableListOf<String>()
        var start = 0
        while (start < line.length) {
            val end = if (line.length - start <= size) line.length else safeEnd(line, start + size).takeIf { it > start } ?: (start + size)
            parts += line.substring(start, end)
            start = end
        }
        return parts
    }

    private fun shortCell(cell: MdInline): MdInline {
        if (cell.length <= CELL_CHARS) return cell
        val runs = mutableListOf<MdRun>()
        var left = CELL_CHARS
        for (run in cell.runs) {
            if (left <= 0) break
            when (run) {
                is MdRun.Text -> { runs += run.copy(text = run.text.substring(0, safeEnd(run.text, minOf(left, run.text.length)))); left -= run.text.length }
                is MdRun.Image -> { runs += run; left -= run.cost }
            }
        }
        runs += MdRun.Text(" …")
        return MdInline(runs)
    }

    /* A paragraph's runs in pieces of at most PARAGRAPH_CHARS, cut at a space where there is one. */
    private fun cutInline(inline: MdInline): List<MdInline> {
        if (inline.length <= PARAGRAPH_CHARS) return listOf(inline)
        val pieces = mutableListOf<MdInline>()
        var current = mutableListOf<MdRun>()
        var length = 0
        fun close() { if (current.isNotEmpty()) pieces += MdInline(current); current = mutableListOf(); length = 0 }
        for (run in inline.runs) {
            if (run is MdRun.Image) { if (length + run.cost > PARAGRAPH_CHARS) close(); current += run; length += run.cost; continue }
            var rest = (run as MdRun.Text).text
            while (length + rest.length > PARAGRAPH_CHARS) {
                val room = PARAGRAPH_CHARS - length
                val space = rest.lastIndexOf(' ', room).takeIf { it > 0 }
                // No space to cut at in this run: a whole new piece if this one has words, else a hard cut.
                val at = space ?: if (length > 0) 0 else safeEnd(rest, room).takeIf { it > 0 } ?: room
                if (at > 0) current += run.copy(text = rest.substring(0, at))
                rest = rest.substring(at).trimStart(' ')
                close()
            }
            if (rest.isNotEmpty()) { current += run.copy(text = rest); length += rest.length }
        }
        close()
        return pieces
    }

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
                // Its alt text bounded, so a paragraph's pieces stay bounded too (cutInline never cuts inside an image).
                is Image -> { flush(); runs += MdRun.Image(alt = shortAlt(flatText(node)), source = node.destination) }
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

    private fun shortAlt(alt: String): String = if (alt.length <= CELL_CHARS) alt else alt.substring(0, safeEnd(alt, CELL_CHARS)) + " …"

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

/*
 * `check` is null for a plain item, true or false for a task list's box. `continued`: the rest of the item before it,
 * cut off with its list (MarkdownDocument.cutList); drawn without a marker, and not numbered.
 */
data class MdItem(val check: Boolean?, val blocks: List<MdBlock>, val continued: Boolean = false)

enum class MdAlign { START, CENTER, END }

data class MdInline(val runs: List<MdRun>) {
    val plainText: String get() = runs.joinToString("") { if (it is MdRun.Text) it.text else (it as MdRun.Image).alt }
    /* What cutting counts: characters, and an image at least MarkdownDocument.IMAGE_CHARS. */
    val length: Int get() = runs.sumOf { if (it is MdRun.Text) it.text.length else (it as MdRun.Image).cost }
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
    data class Image(val alt: String, val source: String?) : MdRun {
        val cost: Int get() = maxOf(alt.length, MarkdownDocument.IMAGE_CHARS)
    }
}
