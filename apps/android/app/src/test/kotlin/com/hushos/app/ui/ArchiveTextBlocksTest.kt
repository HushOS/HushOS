package com.hushos.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* Text from an archive is laid out in blocks bounded by lines and by size: one long line can't make one huge Text. */
class ArchiveTextBlocksTest {
    @Test fun aLongLineIsCutAcrossBlocksAndNothingIsLost() {
        val line = "x".repeat(100_000)
        val blocks = textBlocks(line)
        assertTrue(blocks.all { it.length <= TEXT_BLOCK_CHARS })
        assertEquals(line, blocks.joinToString(""))
    }

    @Test fun manyShortLinesMakeBlocksOfTwoHundredLines() {
        val text = (1..450).joinToString("\n") { "line $it" }
        val blocks = textBlocks(text)
        assertEquals(listOf(200, 200, 50), blocks.map { it.lines().size })
        assertEquals(text, blocks.joinToString("\n"))
    }
}
