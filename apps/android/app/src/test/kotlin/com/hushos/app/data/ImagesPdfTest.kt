package com.hushos.app.data

import com.hushos.core.PageSize
import com.hushos.core.RunControl
import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/*
 * One PDF on Android, as the app builds it (ImagesPdf.build over the core's writer) from the shared
 * fixtures in e2e/fixtures/images: pages in the order given, each JPEG in byte for byte as the
 * cutter leaves it (expected.json's digest, worked out apart from either cutter), nothing of the
 * images' metadata, and refusals that name the image. The platform's decoder (HEIC, PNG) needs a
 * device; on the JVM only the JPEG path runs, which never decodes.
 */
class ImagesPdfTest {
    private val fixtures = File("../../../e2e/fixtures/images")
    private fun fixture(name: String) = File(fixtures, name).readBytes()

    private fun build(vararg images: Pair<String, ByteArray>, size: PageSize = PageSize.FIT, control: RunControl = RunControl(30_000uL, null)) =
        ImagesPdf.build(images.map { it.first }, size, false, 100_000_000L, control, read = { images[it].second })

    private fun ByteArray.has(needle: ByteArray): Boolean {
        outer@ for (i in 0..size - needle.size) {
            for (j in needle.indices) if (this[i + j] != needle[j]) continue@outer
            return true
        }
        return false
    }

    private fun latin1(bytes: ByteArray) = String(bytes, Charsets.ISO_8859_1)

    /* The page boxes, in the PDF's page order (the writer writes each page as its image comes). */
    private fun boxes(pdf: ByteArray) = Regex("/MediaBox \\[0 0 ([0-9.]+) ([0-9.]+)\\]").findAll(latin1(pdf)).map { it.groupValues[1] + "x" + it.groupValues[2] }.toList()

    private fun expectedDigest(name: String): String {
        val table = File(fixtures, "expected.json").readText()
        val at = table.indexOf("\"file\": \"$name\"")
        return Regex("\"sha256\": \"([0-9a-f]{64})\"").find(table, at)!!.groupValues[1]
    }

    @Test
    fun pagesComeInTheOrderGivenEachJpegAsCutAndNothingOfItsMetadata() {
        val gps = fixture("gps.jpg")
        assertTrue("the fixture carries what must be cut", gps.has("HushCanaryCam".toByteArray()))
        val made = build("page-3.jpg" to fixture("page-3.jpg"), "phone-rotated.jpg" to fixture("phone-rotated.jpg"), "gps.jpg" to gps)
        // Fit: each page its image; the phone photo stored 300x400 and shown 400x300.
        assertEquals(listOf("250x250", "400x300", "240x160"), boxes(made.pdf))
        for (needle in listOf("Exif", "HushCanaryCam", "http://ns.adobe.com/xap")) assertFalse(needle, made.pdf.has(needle.toByteArray()))
        val latitude = byteArrayOf(51, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 0x5A, 0x0A, 0, 0, 100, 0, 0, 0)
        assertFalse(made.pdf.has(latitude))
        // The JPEG's stream is the cut file to the byte: found between its own start and end markers.
        val alone = build("gps.jpg" to gps).pdf
        val text = latin1(alone)
        val start = text.indexOf("ÿØÿ")
        val end = text.indexOf("ÿÙ\nendstream") + 2
        val stream = alone.copyOfRange(start, end)
        val digest = MessageDigest.getInstance("SHA-256").digest(stream).joinToString("") { "%02x".format(it) }
        assertEquals(expectedDigest("gps.jpg"), digest)
        assertTrue(made.pdf.has(stream))
    }

    @Test
    fun theRotatedPhotoIsTurnedOnThePageNotReEncoded() {
        val pdf = build("phone-rotated.jpg" to fixture("phone-rotated.jpg")).pdf
        // Drawn a quarter turn clockwise: the stored 300x400 picture, shown 400 wide and 300 high.
        assertTrue(latin1(pdf).contains("q 0 -300 400 0 0 300 cm /Im0 Do Q"))
        assertTrue(latin1(pdf).contains("/Width 300 /Height 400"))
    }

    @Test
    fun refusalsNameTheImage() {
        fun refusal(vararg images: Pair<String, ByteArray>) = try {
            build(*images); fail("made a PDF"); ""
        } catch (refused: ImagesPdfRefused) {
            refused.message
        }
        assertEquals("“b.jpg” is damaged, or isn’t an image HushOS can put in a PDF.",
            refusal("a.jpg" to fixture("plain.jpg"), "b.jpg" to fixture("truncated-segment.jpg")))
        assertEquals("“c.jpg” is a kind of JPEG HushOS can’t put in a PDF.", refusal("c.jpg" to fixture("arithmetic.jpg")))
    }

    @Test
    fun aCancelledRunMakesNothing() {
        val control = RunControl(30_000uL, null)
        control.cancel()
        try {
            build("a.jpg" to fixture("plain.jpg"), control = control)
            fail("made a PDF under a cancelled run")
        } catch (_: com.hushos.core.ImagesPdfException.Failed) {
        }
    }

    @Test
    fun limitsNamesAndPaper() {
        assertEquals(ImagesPdf.Stage.FINE, ImagesPdf.stage(3, 64L shl 20))
        assertEquals(ImagesPdf.Stage.OFFER, ImagesPdf.stage(3, (64L shl 20) + 1))
        assertEquals(ImagesPdf.Stage.CEILING, ImagesPdf.stage(3, (256L shl 20) + 1))
        assertEquals(ImagesPdf.Stage.CEILING, ImagesPdf.stage(501, 1))
        assertEquals("IMG_0001.pdf", ImagesPdf.pdfName("IMG_0001.HEIC"))
        assertEquals("Scan.pdf", ImagesPdf.pdfName("Scan"))
        assertEquals(PageSize.LETTER, ImagesPdf.defaultSize("US"))
        assertEquals(PageSize.LETTER, ImagesPdf.defaultSize("CA"))
        assertEquals(PageSize.A4, ImagesPdf.defaultSize("FR"))
        assertEquals(67_108_864L, ImagesPdf.maxPixels(4L shl 30))
    }
}
