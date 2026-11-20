package com.hushos.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hushos.app.data.transfers.ImagesPdf
import com.hushos.app.data.transfers.ImagesPdfRefused
import com.hushos.core.PageSize
import com.hushos.core.RunControl
import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/*
 * One PDF's decoding on a device (ImageDecoder, which the JVM doesn't have): a PNG keeps its
 * transparency, a WebP goes in as a JPEG, and the PDF is read back with Android's own PdfRenderer,
 * drawn and looked at where a person looks.
 */
@RunWith(AndroidJUnit4::class)
class ImagesPdfDeviceTest {
    private fun encoded(bitmap: Bitmap, format: Bitmap.CompressFormat) =
        ByteArrayOutputStream().also { bitmap.compress(format, 100, it) }.toByteArray()

    /* Red along the top, green down the left, on a pale ground. */
    private fun upright(width: Int, height: Int) = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
        Canvas(it).apply {
            drawColor(Color.rgb(235, 235, 230))
            drawRect(0f, 0f, width.toFloat(), height / 6f, Paint().apply { color = Color.rgb(220, 20, 20) })
            drawRect(0f, height / 6f, width / 8f, height.toFloat(), Paint().apply { color = Color.rgb(20, 160, 40) })
        }
    }

    private fun build(vararg images: Pair<String, ByteArray>, maxPixels: Long = 100_000_000L) =
        ImagesPdf.build(images.map { it.first }, PageSize.FIT, false, maxPixels, RunControl(30_000uL, null), read = { images[it].second })

    /* Each page drawn at a point a pixel by PdfRenderer, on white. */
    private fun render(pdf: ByteArray): List<Bitmap> {
        val file = File.createTempFile("images", ".pdf", InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
        try {
            file.writeBytes(pdf)
            PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)).use { renderer ->
                return (0 until renderer.pageCount).map { index ->
                    renderer.openPage(index).use { page ->
                        Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888).also {
                            it.eraseColor(Color.WHITE)
                            page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        }
                    }
                }
            }
        } finally {
            file.delete()
        }
    }

    private fun red(pixel: Int) = Color.red(pixel) > 150 && Color.green(pixel) < 90 && Color.blue(pixel) < 90
    private fun green(pixel: Int) = Color.green(pixel) > 110 && Color.red(pixel) < 90

    @Test
    fun aPngKeepsItsTransparencyAndAWebpGoesInAsJpeg() {
        val disc = Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).also {
            Canvas(it).drawCircle(32f, 24f, 20f, Paint().apply { color = Color.rgb(200, 30, 30); isAntiAlias = false })
        }
        val webp = encoded(upright(240, 160), Bitmap.CompressFormat.WEBP_LOSSLESS)
        val made = build("disc.png" to encoded(disc, Bitmap.CompressFormat.PNG), "photo.webp" to webp)
        val text = String(made.pdf, Charsets.ISO_8859_1)
        assertTrue("the PNG's transparency is a soft mask", text.contains("/SMask"))
        assertTrue("the WebP went in as a JPEG", text.contains("/DCTDecode"))
        val (page1, page2) = render(made.pdf)
        assertEquals(64 to 48, page1.width to page1.height)
        assertTrue(red(page1.getPixel(32, 24)))
        assertEquals("the ground shows through", Color.WHITE, page1.getPixel(1, 1))
        assertEquals(240 to 160, page2.width to page2.height)
        assertTrue("red at the top", red(page2.getPixel(120, 5)))
        assertTrue("green down the left", green(page2.getPixel(10, 100)))
        assertTrue("not red at the bottom", !red(page2.getPixel(120, 150)))
    }

    @Test
    fun anImagePastTheDevicesPixelsIsRefusedByName() {
        val png = encoded(upright(64, 48), Bitmap.CompressFormat.PNG)
        try {
            build("big.png" to png, maxPixels = 64L * 47)
            fail("decoded past the limit")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("“big.png” is too large to put in a PDF on this device.", refused.message)
        }
        try {
            build("broken.webp" to "not an image".toByteArray())
            fail("made a PDF of nothing")
        } catch (refused: ImagesPdfRefused) {
            assertEquals("“broken.webp” is damaged, or isn’t an image HushOS can put in a PDF.", refused.message)
        }
    }
}
