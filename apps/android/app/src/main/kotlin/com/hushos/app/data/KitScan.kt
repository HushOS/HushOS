package com.hushos.app.data

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer

/*
 * Reading a recovery kit's QR code from a camera frame: the frame's brightness plane
 * (what CameraX's Y plane is) decoded by ZXing, on the phone, and the text handed to
 * RecoveryKitText. Nothing about the frame leaves the device.
 */
object KitScan {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }

    /* The text of a QR code in a greyscale frame (one byte a pixel, `rowStride` bytes a row), or null when there is none. */
    @Synchronized
    fun decode(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): String? = try {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (error: Exception) {
        null
    } finally {
        reader.reset()
    }

    /* The phrase in a frame: a code holding the kit's text or its 24 words; null otherwise. */
    fun phrase(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): List<String>? =
        decode(luminance, width, height, rowStride)?.let(RecoveryKitText::phraseFromScan)
}
