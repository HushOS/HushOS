package com.hushos.app.ui

import android.graphics.Color
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.ResultMetadataType
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/*
 * The branded QR code (`BrandQr`). What these hold: every code the apps draw (a link, an approval
 * code), in dots or squares, reads back to exactly its text through a QR reader with the
 * mark in the middle; it is made at error correction H, which is what pays for the mark; nothing
 * is drawn under the mark, while finder and alignment squares stay square; and the pixels show the
 * mark upright, unmirrored and centred, with dots only where asked for.
 *
 * Drawn for real (Robolectric's native graphics), not a stand-in: the circles, the mark's paths
 * and its rounded square are what is read back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BrandQrTest {
    /* A share link as long as a real one, key in the fragment, and an approval code's payload. */
    private val link = "https://hushos.com/s/5f0c2a9e-4b7d-4c1e-9a3b-2d8e6f1a7c40#k=Qm9vbS1zaGFrYWxha2EtYm9vbS1zaGFrYWxha2EtYm9vbS1zaGFr"
    private val approval = "hushos-approve:7Y2kQ9wPzR4tVb8nLs3aXe6cHd1fGj5mKo0pUq7rSt2uVw9xYz4AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab"

    private fun read(text: String, dots: Boolean): Pair<String, Any?> {
        val bitmap = BrandQr.bitmap(text, dots, side = 360)
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
        val result = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), mapOf(DecodeHintType.CHARACTER_SET to "UTF-8"))
        return result.text to result.resultMetadata?.get(ResultMetadataType.ERROR_CORRECTION_LEVEL)
    }

    @Test
    fun everyCodeReadsBackExactlyAtLevelH() {
        val cases = listOf(link to true, link to false, approval to false, approval to true)
        // Every case is tried and the ones that fail are named together.
        val failed = cases.mapNotNull { (text, dots) ->
            val got = runCatching { read(text, dots) }.getOrElse { return@mapNotNull "$text, dots $dots: $it" }
            if (got != (text to "H")) "$text, dots $dots: read $got" else null
        }
        assertEquals(emptyList<String>(), failed)
    }

    @Test
    fun nothingUnderTheMarkAndFindersStaySquare() {
        for (text in listOf(link, approval)) {
            val layout = BrandQr.layout(text)
            // A quarter of the side, odd, centred on whole modules.
            assertEquals(1, layout.box % 2)
            assertTrue(abs(layout.box - layout.size * 0.24) <= 1)
            assertEquals(layout.size, layout.from * 2 + layout.box)
            assertFalse(layout.modules.any { layout.under(it.x, it.y) })
            // The modules inside a finder are drawn square; a code this long has alignment squares too.
            val inner = layout.size - 2
            val finder = layout.modules.filter { m ->
                val x = m.x - 1
                val y = m.y - 1
                (x < 7 && y < 7) || (x >= inner - 7 && y < 7) || (x < 7 && y >= inner - 7)
            }
            assertTrue(finder.isNotEmpty() && finder.all { it.square })
            // Every alignment square the mark leaves uncovered is drawn square: its centre, and its outer ring's corner.
            val centres = Encoder.encode(text, ErrorCorrectionLevel.H).version.alignmentPatternCenters
            assertTrue(centres.isNotEmpty())
            for (cy in centres) for (cx in centres) {
                if ((cx == 6 && cy == 6) || (cx == 6 && cy == inner - 7) || (cx == inner - 7 && cy == 6) || layout.under(cx + 1, cy + 1)) continue
                assertEquals("alignment centre $cx,$cy", true, layout.modules.firstOrNull { it.x == cx + 1 && it.y == cy + 1 }?.square)
                assertEquals("alignment corner $cx,$cy", true, layout.modules.firstOrNull { it.x == cx - 1 && it.y == cy - 1 }?.square)
            }
        }
    }

    /*
     * The mark upright and unmirrored in the middle, as the web places it, and the dots the caller
     * asked for: a scanner reads the code whatever the mark looks like, so only pixels show these.
     */
    @Test
    fun theMarkSitsUprightAndDotsFollowTheChoice() {
        for (dots in listOf(true, false)) {
            val layout = BrandQr.layout(link)
            val bitmap = BrandQr.bitmap(link, dots, side = layout.size * 12)
            val unit = bitmap.width / layout.size
            fun at(x: Int, y: Int) = Color.red(bitmap.getPixel(x, y)) < 128
            // A point on the mark's own 300 × 419 box, through its place on the 539-unit square.
            val scale = layout.box * unit / 539.0
            val origin = layout.from * unit.toDouble()
            fun mark(x: Double, y: Double) = at((origin + (119.5 + x) * scale).toInt(), (origin + (60 + y) * scale).toInt())
            assertFalse("the bar's top is white: not upside down", mark(214.0, 20.0))
            assertTrue("below the bar's foot is the black square", mark(214.0, 400.0))
            assertTrue("the ring's hole is black", mark(66.0, 210.0))
            assertFalse("the arm to the right is white: not mirrored", mark(234.0, 210.0))
            assertFalse("the square's corner is rounded off", at(layout.from * unit + 1, layout.from * unit + 1))
            // A module's corner: inked for a square, left white by a dot.
            val data = layout.modules.first { !it.square }
            assertEquals("dots $dots", !dots, at(data.x * unit + 1, data.y * unit + 1))
            val fixed = layout.modules.first { it.square }
            assertTrue(at(fixed.x * unit + 1, fixed.y * unit + 1))
        }
    }
}
