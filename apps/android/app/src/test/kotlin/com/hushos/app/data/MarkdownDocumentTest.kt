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
    }

    @Test fun markdownFilesByNameOrType() {
        assertTrue(MarkdownDocument.handles("README.md", null))
        assertTrue(MarkdownDocument.handles("notes.MARKDOWN", null))
        assertTrue(MarkdownDocument.handles("notes", "text/markdown"))
        assertFalse(MarkdownDocument.handles("notes.txt", "text/plain"))
        assertFalse(MarkdownDocument.handles("md", null))
    }
}
