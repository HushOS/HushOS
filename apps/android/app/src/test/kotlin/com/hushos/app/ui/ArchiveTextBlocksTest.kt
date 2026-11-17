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

    @Test fun aLongLineAfterAShortOneKeepsTheLineBreakBetweenThem() {
        // Each block shows as lines of its own: the long line can't run on from "first line".
        val long = "x".repeat(20_000)
        val blocks = textBlocks("first line\n$long\nlast line")
        assertEquals("first line", blocks.first())
        assertTrue(blocks.all { it.length <= TEXT_BLOCK_CHARS })
        assertEquals(long, blocks.drop(1).dropLast(1).joinToString("") + blocks.last().substringBefore('\n'))
        assertEquals("last line", blocks.last().substringAfter('\n'))
    }

    @Test fun manyShortLinesMakeBlocksOfTwoHundredLines() {
        val text = (1..450).joinToString("\n") { "line $it" }
        val blocks = textBlocks(text)
        assertEquals(listOf(200, 200, 50), blocks.map { it.lines().size })
        assertEquals(text, blocks.joinToString("\n"))
    }
}
