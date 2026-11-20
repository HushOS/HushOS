package com.hushos.app

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hushos.app.data.transfers.PdfPages
import com.hushos.core.PdfPagePlan
import com.hushos.core.RunControl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/*
 * Edit pages' drawing on a device (PdfRenderer, which the JVM doesn't have): a page drawn from an
 * anonymous memory file at the size the core gives it, turned to the rotation asked for whatever the
 * page's own /Rotate, and a PDF the core wrote drawn back the way it was turned. Each page has a green
 * band along its bottom edge, so where the band lands says which way the page stands.
 */
@RunWith(AndroidJUnit4::class)
class PdfPagesDeviceTest {
    /* Two 200 by 100 pages, a green band along each one's bottom; the second turned 90 by its own /Rotate. */
    private val pdf: ByteArray = run {
        val content = "0 0.6 0 rg 0 0 200 20 re f"
        val objects = listOf(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Contents 5 0 R >>",
            "<< /Length ${content.length} >>\nstream\n$content\nendstream",
        )
        val out = StringBuilder("%PDF-1.4\n")
        val offsets = objects.mapIndexed { index, body ->
            out.length.also { out.append("${index + 1} 0 obj\n$body\nendobj\n") }
        }
        val xref = out.length
        out.append("xref\n0 ${objects.size + 1}\n0000000000 65535 f \n")
        offsets.forEach { out.append("%010d 00000 n \n".format(it)) }
        out.append("trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        out.toString().toByteArray(Charsets.ISO_8859_1)
    }

    private fun green(bitmap: Bitmap, x: Int, y: Int) = bitmap.getPixel(x, y).let { Color.green(it) > 100 && Color.red(it) < 60 }

    private fun drawn(bytes: ByteArray, page: Int, rotate: UInt): Bitmap {
        val read = PdfPages.inspect(listOf("test.pdf"), RunControl(30_000uL, null), read = { bytes })
        val info = read.inspections[0].pages[page]
        val (w, h) = PdfPages.imageSize(info, rotate, 72u)
        val renderer = PdfPages.renderer(bytes)
        assertNotNull("PdfRenderer opens the bytes from memory", renderer)
        return renderer!!.use { PdfPages.draw(it, page, info.rotate, rotate, w, h)!! }
    }

    @Test
    fun aPageIsDrawnTurnedToTheRotationAskedFor() {
        assumeTrue("PdfRenderer reads from memory from Android 11 on", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        // Upright: 200 by 100, the band along the bottom.
        drawn(pdf, 0, 0u).let {
            assertEquals(200 to 100, it.width to it.height)
            assertTrue(green(it, 100, 95))
            assertTrue(!green(it, 100, 5))
        }
        // Turned a quarter clockwise: 100 by 200, the bottom edge now down the left.
        drawn(pdf, 0, 90u).let {
            assertEquals(100 to 200, it.width to it.height)
            assertTrue(green(it, 5, 100))
            assertTrue(!green(it, 95, 100))
        }
        // The second page turns itself 90; asked for 0, it stands upright, its own turn replaced, not added to.
        drawn(pdf, 1, 0u).let {
            assertEquals(200 to 100, it.width to it.height)
            assertTrue(green(it, 100, 95))
        }
        // And asked for 270: the band along the right.
        drawn(pdf, 1, 270u).let {
            assertEquals(100 to 200, it.width to it.height)
            assertTrue(green(it, 95, 100))
            assertTrue(!green(it, 5, 100))
        }
    }

    @Test
    fun aPdfTheCoreTurnedIsDrawnTheWayItWasTurned() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        val read = PdfPages.inspect(listOf("test.pdf"), RunControl(30_000uL, null), read = { pdf })
        var made: ByteArray? = null
        PdfPages.build(read.data, listOf("test.pdf"), listOf(listOf(PdfPagePlan(0u, 0u, 180u))), RunControl(30_000uL, null)) { _, bytes -> made = bytes }
        // Turned 180 by the core: PdfRenderer shows it upside down, the band along the top.
        val bytes = made!!
        val again = PdfPages.inspect(listOf("made.pdf"), RunControl(30_000uL, null), read = { bytes })
        assertEquals(180u, again.inspections[0].pages[0].rotate)
        drawn(bytes, 0, 180u).let {
            assertTrue(green(it, 100, 5))
            assertTrue(!green(it, 100, 95))
        }
    }
}
