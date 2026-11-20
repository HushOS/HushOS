package com.hushos.app.data.transfers

import com.hushos.core.PdfPagePlan
import com.hushos.core.RunControl
import com.hushos.core.pdfInspect
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * Edit pages on Android, as the app builds it (PdfPages.inspect and PdfPages.build over the core's
 * writer) from the shared fixtures in e2e/fixtures/pdfs: each output's pages in the order planned,
 * turned as planned, each page's own content and none of another's, no document information, and
 * refusals in the person's words. Drawing with PdfRenderer needs a device (PdfPagesDeviceTest).
 */
class PdfPagesTest {
    private val fixtures = File("../../../e2e/fixtures/pdfs")
    private fun fixture(name: String) = File(fixtures, name).readBytes()
    private fun control() = RunControl(30_000uL, null)

    private fun read(vararg names: String) = PdfPages.inspect(names.toList(), control(), read = { fixture(names[it]) })

    private fun build(names: List<String>, outputs: List<List<PdfPagePlan>>): List<ByteArray> {
        val read = PdfPages.inspect(names, control(), read = { fixture(names[it]) })
        val made = mutableListOf<ByteArray>()
        PdfPages.build(read.data, names, outputs, control()) { _, bytes -> made += bytes }
        return made
    }

    private fun ByteArray.find(needle: String, from: Int = 0): Int {
        val bytes = needle.toByteArray(Charsets.ISO_8859_1)
        outer@ for (i in from..size - bytes.size) {
            for (j in bytes.indices) if (this[i + j] != bytes[j]) continue@outer
            return i
        }
        return -1
    }

    /* The "(Page n)" each page's content draws, in the order the copied content streams are written. */
    private fun labels(pdf: ByteArray) = Regex("\\((Page \\d)\\) Tj").findAll(String(pdf, Charsets.ISO_8859_1)).map { it.groupValues[1] }.toList()

    private fun plan(source: Int, page: Int, rotate: Int) = PdfPagePlan(source.toUInt(), page.toUInt(), rotate.toUInt())

    @Test
    fun mergingKeepsThePlannedOrderAndRotations() {
        val made = build(listOf("plain.pdf", "rotated.pdf"), listOf(listOf(plan(0, 2, 0), plan(0, 0, 90), plan(1, 1, 0))))[0]
        // Read back by the core: three pages, sizes and turns as planned.
        val pages = pdfInspect(made, control()).pages
        assertEquals(listOf(400.0 to 600.0, 612.0 to 792.0, 720.0 to 405.0), pages.map { it.width to it.height })
        assertEquals(listOf(0u, 90u, 0u), pages.map { it.rotate })
        // And by the bytes: the pages' own content, in that order, and plain's page 2 (left out) not there.
        assertEquals(listOf("Page 3", "Page 1", "Page 2"), labels(made))
        assertEquals(-1, made.find("595 842"))
    }

    @Test
    fun splittingGivesEachRangeOnlyItsPages() {
        val ranges = PdfPages.ranges(3, setOf(0))
        assertEquals(listOf(0..0, 1..2), ranges)
        val made = build(listOf("plain.pdf"), ranges.map { range -> range.map { plan(0, it, 0) } })
        assertEquals(listOf("Page 1"), labels(made[0]))
        assertEquals(listOf("Page 2", "Page 3"), labels(made[1]))
        assertEquals("plain (pages 2–3).pdf", PdfPages.splitName("plain.pdf", 2, 3))
        assertEquals("plain (page 1).pdf", PdfPages.splitName("plain.pdf", 1, 1))
        assertEquals("plain (merged).pdf", PdfPages.mergedName("plain.pdf"))
        assertEquals("plain (images)", PdfPages.imagesFolderName("plain.pdf"))
        assertEquals("page 001.png", PdfPages.pageImageName(0, true))
        assertEquals("page 012.jpg", PdfPages.pageImageName(11, false))
    }

    @Test
    fun outputsCarryNoDocumentInformation() {
        val made = build(listOf("plain.pdf"), listOf(listOf(plan(0, 0, 0))))[0]
        for (needle in listOf("HUSHOS-CANARY-INFO-c37a", "/Info", "/Producer", "/Creator", "/CreationDate", "/ObjStm")) {
            assertEquals(needle, -1, made.find(needle))
        }
        assertTrue(made.find("%PDF-1.7") == 0)
    }

    @Test
    fun aPasswordIsRefusedAndWhatSavingLosesIsSaid() {
        try {
            read("encrypted.pdf")
            fail("a PDF with a password was read")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("This PDF has a password. Remove it in another app, then try again.", refused.message)
        }
        try {
            read("plain.pdf", "encrypted.pdf")
            fail("a PDF with a password was read")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("“encrypted.pdf” has a password. Remove it in another app, then try again.", refused.message)
        }
        try {
            read("tree-cycle.pdf")
            fail("a page tree that loops was read")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("This PDF is damaged, or isn’t something HushOS can read.", refused.message)
        }
        val signed = read("signed.pdf").inspections[0]
        assertTrue(signed.signed && signed.form && !signed.outline)
        val form = read("outline-form.pdf").inspections[0]
        assertTrue(!form.signed && form.form && form.outline)
        assertFalse(read("unsigned-field.pdf").inspections[0].signed)
    }

    @Test
    fun anOutputPastTheHeapsShareIsRefusedAndACancelStopsTheWriter() {
        val read = read("plain.pdf")
        try {
            PdfPages.build(read.data, listOf("plain.pdf"), listOf(listOf(plan(0, 0, 0))), control(), maxOutput = 100) { _, _ -> fail("built past the limit") }
            fail("an output past the limit was made")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("“The PDF” would be too large to make on this phone. Split it into smaller files.", refused.message)
        }
        val stopped = control().also { it.cancel() }
        try {
            PdfPages.build(read.data, listOf("plain.pdf"), listOf(listOf(plan(0, 0, 0))), stopped) { _, _ -> fail("built after a cancel") }
            fail("a cancelled run built")
        } catch (_: Exception) {
        }
    }

    @Test
    fun limitsFollowTheMemoryAndTheHeap() {
        val roomy = PdfPages.limits(8L shl 30)
        assertEquals(256uL shl 20, roomy.maxInputBytes)
        // A 192 MB heap holds an array of a third of it: 64 MB in, the card at half of that.
        val heap = PdfPages.limits(8L shl 30, 192L shl 20)
        assertEquals(64uL shl 20, heap.maxInputBytes)
        assertEquals(32uL shl 20, heap.cardBytes)
        assertEquals(PdfPages.Stage.FINE, PdfPages.stage(1, 32L shl 20, heap))
        assertEquals(PdfPages.Stage.OFFER, PdfPages.stage(1, (32L shl 20) + 1, heap))
        assertEquals(PdfPages.Stage.CEILING, PdfPages.stage(1, (64L shl 20) + 1, heap))
        assertEquals(PdfPages.Stage.CEILING, PdfPages.stage(101, 1, roomy))
        assertEquals(PdfPages.Stage.OFFER, PdfPages.imagesStage(51, roomy))
        assertEquals(PdfPages.Stage.CEILING, PdfPages.imagesStage(501, roomy))
    }
}
