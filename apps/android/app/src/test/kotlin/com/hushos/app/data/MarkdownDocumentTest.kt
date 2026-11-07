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
        assertTrue((level.first() as MdBlock.Paragraph).inline.plainText.endsWith("hello"))

        val emphasis = paragraph("*a ".repeat(3000) + "deep" + " a*".repeat(3000))
        assertTrue(emphasis.plainText.contains("deep"))
    }

    @Test fun markdownFilesByNameOrType() {
        assertTrue(MarkdownDocument.handles("README.md", null))
        assertTrue(MarkdownDocument.handles("notes.MARKDOWN", null))
        assertTrue(MarkdownDocument.handles("notes", "text/markdown"))
        assertFalse(MarkdownDocument.handles("notes.txt", "text/plain"))
        assertFalse(MarkdownDocument.handles("md", null))
    }
}
