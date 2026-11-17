package com.hushos.app.data

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.BitMatrix
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.multi.qrcode.detector.MultiFinderPatternFinder
import com.google.zxing.qrcode.decoder.Decoder
import com.google.zxing.qrcode.detector.Detector
import com.google.zxing.qrcode.detector.FinderPatternInfo

/*
 * Reading a QR code from a camera frame (the recovery kit's, another device's approval request):
 * the frame's brightness plane (what CameraX's Y plane is) decoded by ZXing, on the phone, and
 * the text handed on. Nothing about the frame leaves the device.
 *
 * ZXing's usual reader settles on one set of three finder squares, and for about one approval
 * code in seventy to ninety (version 8 at level H) it takes a run of data modules for the
 * bottom-left finder in some poses, so the code can take many frames to read. A frame the usual
 * reader cannot read, or that holds a code the caller did not ask for, is read again set by set:
 * every plausible set of three finders, the first text the caller accepts winning. The sets are
 * capped: their number grows with the cube of the finders in view, and a sheet of QR labels
 * would otherwise hold the camera's thread for seconds.
 */
object KitScan {
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)
    private val reader = MultiFormatReader().apply { setHints(hints) }
    private val decoder = Decoder()

    /* Sets of three finders tried after the usual reader: six codes in view make 41. */
    internal const val MOST_SETS = 64

    /* ZXing's detector, for one given set of finders. */
    private class OneSet(matrix: BitMatrix) : Detector(matrix) {
        fun bits(info: FinderPatternInfo): BitMatrix = processFinderPatternInfo(info).bits
    }

    /*
     * The text of a QR code in a greyscale frame (one byte a pixel, `rowStride` bytes a row) that
     * `accept` takes, or null when there is none. `accept` runs outside every catch: a predicate
     * that throws is a bug to see, not a frame with no code.
     */
    @Synchronized
    fun decode(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width, accept: (String) -> Boolean = { true }): String? {
        // One black-and-white picture for both readers: neither changes it without ALSO_INVERTED.
        val bitmap = BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)))
        val first = try {
            reader.decodeWithState(bitmap).text
        } catch (error: Exception) {
            null
        } finally {
            reader.reset()
        }
        if (first != null && accept(first)) return first
        val matrix = try {
            bitmap.blackMatrix
        } catch (error: Exception) {
            return null
        }
        val sets = try {
            MultiFinderPatternFinder(matrix, null).findMulti(hints)
        } catch (error: Exception) {
            return null
        }
        val detector = OneSet(matrix)
        for (set in sets.take(MOST_SETS)) {
            val text = try {
                decoder.decode(detector.bits(set), hints).text
            } catch (error: Exception) {
                null
            }
            if (text != null && accept(text)) return text
        }
        return null
    }

    /* The phrase in a frame: a code holding the kit's text or its 24 words; null otherwise. */
    fun phrase(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): List<String>? =
        decode(luminance, width, height, rowStride) { RecoveryKitText.phraseFromScan(it) != null }?.let(RecoveryKitText::phraseFromScan)
}
