package com.hushos.app.foreign

import com.hushos.app.data.transfers.PdfPages
import com.hushos.core.PdfPagePlan
import com.hushos.core.RunControl
import com.hushos.core.ToolBudget
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * Edit pages' outputs are saved one at a time (PdfPages.buildEach, through ToolRuns, whose clock is a
 * foreign trait, hence this package): while one is being saved the budget holds its bytes and nothing
 * of the ones before it, so a split never holds every output at once.
 */
class PdfPagesBuildTest {
    private val fixtures = File("../../../e2e/fixtures/pdfs")

    @Test
    fun eachOutputIsSavedBeforeTheNextIsBuiltItsBytesCountedUntilThen() = runBlocking {
        val read = PdfPages.inspect(listOf("plain.pdf"), RunControl(30_000uL, null), read = { File(fixtures, "plain.pdf").readBytes() })
        val budget = ToolBudget(512uL shl 20)
        val seen = mutableListOf<Pair<ULong, Int>>()
        val plans = (0 until 3).map { listOf(PdfPagePlan(0u, it.toUInt(), 0u)) }
        PdfPages.buildEach(read, listOf("plain.pdf"), plans, PdfPages.limits(8L shl 30), budget) { _, made ->
            seen += budget.waiting() to made.size
        }
        assertEquals(3, seen.size)
        for ((waiting, bytes) in seen) assertEquals(bytes.toULong(), waiting)
        assertEquals(0uL, budget.waiting())
    }
}
