package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* The Markdown viewer's rules: what a document may make the phone do, and what it says. iOS's MarkdownDocumentTests ask the same. */
class MarkdownDocumentTest {
    private fun paragraph(source: String): MdInline = (MarkdownDocument.parse(source).first() as MdBlock.Paragraph).inline

    private fun links(inline: MdInline) = inline.runs.mapNotNull { (it as? MdRun.Text)?.link }.distinct()

    @Test fun onlyWebAndMailLinksAreLinks() {
        val inline = paragraph("[a](https://example.com) [b](javascript:alert(1)) [c](file:///etc/passwd) [d](./notes.md) [e](mailto:sam@example.com) [f](intent://x#Intent;end)")
        assertEquals(listOf("https://example.com", "mailto:sam@example.com"), links(inline))
        // The words of a refused link stay, without the link.
        assertTrue(inline.plainText.contains("b"))
    }

    @Test fun aBareAddressIsALinkOnlyOnTheWeb() {
        assertEquals(listOf("https://example.com/a"), links(paragraph("See https://example.com/a for more")))
    }

    @Test fun anImageIsNamedNotFetched() {
        val inline = paragraph("Look ![the tracker](https://tracker.example/pixel.png) here")
        assertTrue(inline.runs.contains(MdRun.Image("the tracker", "https://tracker.example/pixel.png")))
        // Nothing about the image is a link the viewer would open or load.
        assertTrue(links(inline).isEmpty())
    }

    @Test fun rawHtmlIsDroppedNotShown() {
        val blocks = MarkdownDocument.parse("<script>alert(1)</script>\n\nSafe <img src=x onerror=alert(1)> text")
        assertEquals(1, blocks.size)
        val inline = (blocks.first() as MdBlock.Paragraph).inline
        assertFalse(inline.plainText.contains("<"))
        assertTrue(inline.plainText.contains("Safe"))
    }

    @Test fun taskListsKeepTheirBoxes() {
        val list = MarkdownDocument.parse("- [x] done\n- [ ] to do\n- plain").first() as MdBlock.ListBlock
        assertEquals(listOf(true, false, null), list.items.map { it.check })
        // The box is drawn, not left in the words as "[x]".
        assertEquals("done", (list.items.first().blocks.first() as MdBlock.Paragraph).inline.plainText.trim())
    }

    @Test fun tablesKeepCellsAndAlignment() {
        val table = MarkdownDocument.parse("| Name | Size |\n| :-- | --: |\n| a.txt | 2 KB |").first() as MdBlock.Table
        assertEquals(listOf("Name", "Size"), table.head.map { it.plainText })
        assertEquals(listOf(MdAlign.START, MdAlign.END), table.alignments)
        assertEquals(listOf(listOf("a.txt", "2 KB")), table.rows.map { row -> row.map { it.plainText } })
    }

    @Test fun orderedListsKeepTheirStart() {
        val list = MarkdownDocument.parse("3. three\n4. four").first() as MdBlock.ListBlock
        assertTrue(list.ordered)
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)
    }

    @Test fun deepNestingIsDrawnOnlySoFarAndKeepsItsWords() {
        // Past the drawing budget the words come as plain text, so neither the parse nor the viewer recurses further.
        var level = MarkdownDocument.parse("> ".repeat(5000) + "hello")
        var depth = 0
        while (true) { level = (level.firstOrNull() as? MdBlock.Quote ?: break).blocks; depth++ }
        assertEquals(MarkdownDocument.BLOCK_DEPTH, depth)
        assertTrue((level.last() as MdBlock.Paragraph).inline.plainText.endsWith("hello"))

        val emphasis = MarkdownDocument.parse("*a ".repeat(3000) + "deep" + " a*".repeat(3000)).joinToString(" ") { (it as MdBlock.Paragraph).inline.plainText }
        assertTrue(emphasis.contains("deep"))
    }

    @Test fun bigBlocksComeInPiecesTheViewerCanLayOutOneAtATime() {
        // A 1.5 MB paragraph as one text held the UI thread for half a minute: it comes as paragraphs of at most the limit,
        // cut between words, with every word kept.
        val words = (0 until 150_000).map { "word$it" }
        val paragraphs = MarkdownDocument.parse(words.joinToString(" ")).map { it as MdBlock.Paragraph }
        assertTrue(paragraphs.size > 1)
        assertTrue(paragraphs.all { it.inline.plainText.length <= MarkdownDocument.PARAGRAPH_CHARS })
        assertEquals(words, paragraphs.flatMap { it.inline.plainText.split(' ') })

        val code = MarkdownDocument.parse("```\n" + (1..1000).joinToString("\n") { "line $it" } + "\n```").map { it as MdBlock.Code }
        assertEquals(5, code.size)
        assertEquals((1..1000).map { "line $it" }, code.flatMap { it.text.split('\n') })

        val tables = MarkdownDocument.parse("| A | B |\n| - | - |\n" + (1..450).joinToString("\n") { "| $it | x |" }).map { it as MdBlock.Table }
        assertEquals(listOf(200, 200, 50), tables.map { it.rows.size })
        // A single huge line, in code or in a table cell, never makes one huge text either.
        val line = MarkdownDocument.parse("```\n" + "y".repeat(300_000) + "\n```").map { it as MdBlock.Code }
        assertTrue(line.all { it.text.length <= MarkdownDocument.PARAGRAPH_CHARS })
        assertEquals(300_000, line.sumOf { it.text.length })
        val cell = (MarkdownDocument.parse("| A |\n| - |\n| " + "x".repeat(300_000) + " |").single() as MdBlock.Table).rows.single().single()
        assertTrue(cell.plainText.length <= MarkdownDocument.CELL_CHARS + 2 && cell.plainText.endsWith("…"))

        // Each piece keeps the head, so a column is never left unnamed.
        assertTrue(tables.all { t -> t.head.map { it.plainText } == listOf("A", "B") })

        // A heading is cut as a paragraph is, every piece at its level.
        val heading = MarkdownDocument.parse("## " + words.take(20_000).joinToString(" ")).map { it as MdBlock.Heading }
        assertTrue(heading.size > 1 && heading.all { it.level == 2 && it.inline.length <= MarkdownDocument.PARAGRAPH_CHARS })
        assertEquals(words.take(20_000), heading.flatMap { it.inline.plainText.split(' ') })

        // A long image description can't push a piece past the limit: the text after it is still cut where it must be.
        val pictured = MarkdownDocument.parse("![" + "a".repeat(5000) + "](x.png) " + words.take(2000).joinToString(" ")).map { it as MdBlock.Paragraph }
        assertTrue(pictured.all { it.inline.length <= MarkdownDocument.PARAGRAPH_CHARS })
        assertTrue((pictured.first().inline.runs.first() as MdRun.Image).alt.endsWith("…"))

        // Images without words are each drawn as a mark: 10,000 of them aren't one paragraph.
        val marks = MarkdownDocument.parse("![](x) ".repeat(10_000)).map { it as MdBlock.Paragraph }
        assertTrue(marks.size > 1 && marks.all { it.inline.runs.size <= MarkdownDocument.PARAGRAPH_CHARS / MarkdownDocument.IMAGE_CHARS * 2 })
        assertEquals(10_000, marks.sumOf { p -> p.inline.runs.count { it is MdRun.Image } })

        // A 1,000-column table: 50 columns and a "…" one, in pieces of a bounded number of cells.
        val wide = MarkdownDocument.parse("|" + " c |".repeat(1000) + "\n|" + " - |".repeat(1000) + "\n" + "| x |\n".repeat(200)).map { it as MdBlock.Table }
        assertTrue(wide.all { it.head.size == MarkdownDocument.TABLE_COLUMNS + 1 && it.head.last().plainText == "…" })
        assertTrue(wide.all { (it.rows.size + 1) * it.head.size <= MarkdownDocument.TABLE_CELLS + it.head.size })
        assertEquals(200, wide.sumOf { it.rows.size })
    }

    @Test fun bigListsAndQuotesComeInPiecesNumberedOn() {
        // 100,000 items as one list laid out every row at once; in pieces, each no heavier than the limit, numbered on.
        val lists = MarkdownDocument.parse((1..100_000).joinToString("\n") { "$it. item $it" }).map { it as MdBlock.ListBlock }
        assertTrue(lists.size > 1 && lists.all { MarkdownDocument.weight(it) <= MarkdownDocument.BLOCK_WEIGHT })
        val numbered = lists.flatMap { list -> list.items.mapIndexed { index, item -> "${list.start + index}:${(item.blocks.single() as MdBlock.Paragraph).inline.plainText}" } }
        assertEquals((1..100_000).map { "$it:item $it" }, numbered)

        // One item holding a huge list: its rest goes on in later pieces, unmarked, and the next item keeps its number.
        val nested = MarkdownDocument.parse("1. outer\n" + (1..5000).joinToString("\n") { "   - inner $it" } + "\n2. after").map { it as MdBlock.ListBlock }
        assertTrue(nested.size > 1 && nested.all { MarkdownDocument.weight(it) <= MarkdownDocument.BLOCK_WEIGHT + 2 * MarkdownDocument.BLOCK_DEPTH })
        assertTrue(nested.drop(1).all { it.items.first().continued } && nested.all { list -> list.items.drop(1).none { it.continued } })
        val last = nested.last()
        assertEquals(2, last.start + last.items.indexOfFirst { !it.continued })
        fun inner(blocks: List<MdBlock>): List<String> = blocks.flatMap { b -> (b as? MdBlock.ListBlock)?.items?.flatMap { i -> i.blocks.mapNotNull { (it as? MdBlock.Paragraph)?.inline?.plainText } }.orEmpty() }
        assertEquals((1..5000).map { "inner $it" }, nested.flatMap { list -> list.items.flatMap { inner(it.blocks) } })

        // A quote of many paragraphs, likewise.
        val quotes = MarkdownDocument.parse((1..5000).joinToString("\n>\n") { "> line $it" }).map { it as MdBlock.Quote }
        assertTrue(quotes.size > 1 && quotes.all { MarkdownDocument.weight(it) <= MarkdownDocument.BLOCK_WEIGHT })
        assertEquals((1..5000).map { "line $it" }, quotes.flatMap { q -> q.blocks.map { (it as MdBlock.Paragraph).inline.plainText } })
    }

    @Test fun markdownFilesByNameOrType() {
        assertTrue(MarkdownDocument.handles("README.md", null))
        assertTrue(MarkdownDocument.handles("notes.MARKDOWN", null))
        assertTrue(MarkdownDocument.handles("notes", "text/markdown"))
        assertFalse(MarkdownDocument.handles("notes.txt", "text/plain"))
        assertFalse(MarkdownDocument.handles("md", null))
    }
}
