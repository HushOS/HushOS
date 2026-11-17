package com.hushos.app.data

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.multi.qrcode.QRCodeMultiReader

/*
 * Reading a QR code from a camera frame (the recovery kit's, another device's approval request):
 * the frame's brightness plane (what CameraX's Y plane is) decoded by ZXing, on the phone, and
 * the text handed on. Nothing about the frame leaves the device.
 *
 * ZXing's usual reader settles on one set of three finder squares, and in about one code in
 * seventy (measured on approval codes, version 8 at level H) it takes a run of data modules for
 * the bottom-left finder and reads nothing, however clean the picture. Its multi-code reader
 * tries every plausible set, so a frame the usual reader cannot read is read again with it. That
 * also finds the code asked for when a frame holds another one too.
 */
object KitScan {
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)
    private val reader = MultiFormatReader().apply { setHints(hints) }
    private val several = QRCodeMultiReader()

    /*
     * The text of a QR code in a greyscale frame (one byte a pixel, `rowStride` bytes a row) that
     * `accept` takes, or null when there is none.
     */
    @Synchronized
    fun decode(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width, accept: (String) -> Boolean = { true }): String? {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        val first = try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (error: Exception) {
            null
        } finally {
            reader.reset()
        }
        if (first != null && accept(first)) return first
        return try {
            several.decodeMultiple(BinaryBitmap(HybridBinarizer(source)), hints).map { it.text }.firstOrNull(accept)
        } catch (error: Exception) {
            null
        }
    }

    /* The phrase in a frame: a code holding the kit's text or its 24 words; null otherwise. */
    fun phrase(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): List<String>? =
        decode(luminance, width, height, rowStride) { RecoveryKitText.phraseFromScan(it) != null }?.let(RecoveryKitText::phraseFromScan)
}
