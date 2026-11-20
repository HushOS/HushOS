package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * The editor's preview scrolls with its source by the lines each block came from. Fails if a block names the wrong source
 * lines (the preview would sit on the wrong paragraph), or if a line maps to a place that doesn't map back to it. iOS's
 * SideBySideTests ask the same.
 */
class MarkdownLinesTest {
    @Test fun eachBlockStartsAtItsSourceLine() {
        val text = listOf("# Title", "", "A paragraph", "over two lines.", "", "- one", "- two", "", "```", "code", "```", "", "> quoted").joinToString("\n")
        assertEquals(listOf(1.0, 3.0, 6.0, 9.0, 13.0), MarkdownDocument.parseLined(text).map { it.start })
        // And the blocks are the viewer's, in the same order.
        assertEquals(MarkdownDocument.parse(text), MarkdownDocument.parseLined(text).map { it.block })
    }

    @Test fun aBlockCutInPiecesSharesItsLinesOut() {
        // One paragraph on line 3 too long to lay out at once: cut in three, sharing lines 3 to 4.
        val words = "word ".repeat(MarkdownDocument.PARAGRAPH_CHARS * 2 / 5 + 10)
        val pieces = MarkdownDocument.parseLined("# Title\n\n$words\n")
        assertEquals(4, pieces.size)
        assertEquals(3.0, pieces[1].start, 1e-9)
        assertEquals(3 + 1.0 / 3, pieces[2].start, 1e-9)
        assertEquals(3 + 2.0 / 3, pieces[3].start, 1e-9)
    }

    @Test fun aLineFindsItsBlockAndComesBack() {
        // Blocks at lines 1, 3 and 6 of a nine-line file.
        val map = LineMap(listOf(1.0, 3.0, 6.0), 9)
        assertEquals(0 to 0.25, map.place(1.5))
        // A blank line between two blocks belongs to the one before.
        assertEquals(1 to 5.0 / 6, map.place(5.5))
        assertEquals(2 to 0.5, map.place(8.0))
        for (line in listOf(1.0, 2.25, 3.5, 5.9, 6.0, 9.5)) {
            val (index, fraction) = map.place(line)!!
            assertEquals(line, map.line(index, fraction)!!, 1e-9)
        }
        // Above the first block (blank lines at the top of the file): its top.
        assertEquals(0 to 0.0, LineMap(listOf(4.0), 6).place(2.0))
        assertNull(LineMap(emptyList(), 3).place(2.0))
    }

    @Test fun textLinesCountInUtf16() {
        // An emoji is two UTF-16 units, as an EditText counts.
        val lines = TextLines("a😀\nb\n\nlast")
        assertEquals(4, lines.count)
        assertEquals(4, lines.startOf(2))
        assertEquals(1, lines.lineAt(3))
        assertEquals(2, lines.lineAt(4))
        assertEquals(4, lines.lineAt(7))
        assertEquals(7, lines.startOf(99))
    }
}
