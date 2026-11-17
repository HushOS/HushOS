package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* A kit is read back only when it is one; a stray file or a short phrase is refused before any word is used. */
class RecoveryKitTextTest {
    private val phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual"
    private val words = phrase.split(" ")

    /* The kit as the web and this app write it (apps/web/src/lib/recovery-kit.ts kitText). */
    private fun kit(line: String = phrase, newline: String = "\n") = listOf(
        "HushOS recovery kit", "Saved 2026-10-05", "", "YOUR ACCOUNT", "Email:       maya@example.com", "",
        "YOUR RECOVERY PHRASE (24 words, in this order)", " 1. abandon       2. ability", "",
        "The same phrase on one line, for pasting:", line, "", "FOR RECOVERY TOOLS", "{}",
    ).joinToString(newline)

    @Test
    fun aKitFileGivesItsTwentyFourWords() {
        assertEquals(words, RecoveryKitText.phraseFromKit(kit()))
        // Saved on Windows, or with the phrase line spaced oddly or in capitals.
        assertEquals(words, RecoveryKitText.phraseFromKit(kit(newline = "\r\n")))
        assertEquals(words, RecoveryKitText.phraseFromKit(kit("  " + phrase.uppercase().replace(" ", "   \t") + "  ")))
    }

    @Test
    fun aStrayFileIsRefused() {
        assertNull(RecoveryKitText.phraseFromKit("Shopping list\nmilk eggs bread"))
        assertNull(RecoveryKitText.phraseFromKit(phrase)) // the words alone aren't a kit file
        assertNull(RecoveryKitText.phraseFromKit(kit(words.dropLast(1).joinToString(" "))))
        assertNull(RecoveryKitText.phraseFromKit(kit("$phrase extra")))
        assertNull(RecoveryKitText.phraseFromKit(kit(phrase.replace("abandon", "aband0n"))))
        assertNull(RecoveryKitText.phraseFromKit("HushOS recovery kit\nno phrase line here"))
    }

    @Test
    fun aScannedCodeMayHoldTheKitOrJustTheWords() {
        assertEquals(words, RecoveryKitText.phraseFromScan(kit()))
        assertEquals(words, RecoveryKitText.phraseFromScan(phrase.replace(" ", "\n")))
        assertNull(RecoveryKitText.phraseFromScan("https://hushos.com/s/abc#def"))
        // The web's printed code holds exactly the 24 words; one short or one over is not a phrase.
        assertNull(RecoveryKitText.phraseFromScan(words.drop(1).joinToString(" ")))
        assertNull(RecoveryKitText.phraseFromScan((words + "abandon").joinToString(" ")))
    }

    @Test
    fun typingCompletesFromTheWordList() {
        val list = File("src/main/res/raw/bip39_english.txt").readLines().filter { it.isNotBlank() }
        assertEquals(listOf("abandon", "ability", "able", "about"), RecoveryKitText.complete("ab", list))
        assertEquals(listOf("zoo"), RecoveryKitText.complete("ZOO", list))
        assertEquals(emptyList<String>(), RecoveryKitText.complete(" ", list))
    }
}

/* A QR code holding the words, as a camera frame's brightness plane, reads back as the phrase; any other code does not. */
class KitScanTest {
    private val phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual"

    private fun frame(text: String, size: Int = 400): ByteArray {
        val matrix = com.google.zxing.qrcode.QRCodeWriter().encode(text, com.google.zxing.BarcodeFormat.QR_CODE, size, size)
        return ByteArray(size * size) { i -> if (matrix.get(i % size, i / size)) 0 else 255.toByte() }
    }

    @Test
    fun aCodeOfTheWordsGivesThePhrase() {
        assertEquals(phrase.split(" "), KitScan.phrase(frame(phrase), 400, 400))
    }

    @Test
    fun anotherCodeOrABlankFrameGivesNothing() {
        assertNull(KitScan.phrase(frame("https://hushos.com/s/abc#def"), 400, 400))
        assertNull(KitScan.phrase(ByteArray(400 * 400) { 200.toByte() }, 400, 400))
    }
}

/*
 * Another device's approval request, as the approving phone's camera sees it: every real one reads.
 * ZXing's usual reader alone misses about one code in seventy of these (it takes data for a finder
 * square), clean or not; these fail on that and hold the fallback to every one.
 */
class ApprovalScanTest {
    /* A request's code as every client draws it: `hushos-approve:` and 48 bytes, level H, square modules. */
    private fun request(random: java.util.Random): String {
        val bytes = ByteArray(48).also(random::nextBytes)
        return "hushos-approve:" + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun matrix(text: String) = com.google.zxing.qrcode.encoder.Encoder.encode(text, com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.H).matrix

    /* Codes drawn `unit` pixels a module, side by side, with four modules of white round each, on a white frame. */
    private fun drawn(texts: List<String>, unit: Int = 8): Triple<ByteArray, Int, Int> {
        val codes = texts.map(::matrix)
        val width = codes.sumOf { (it.width + 8) * unit }
        val height = codes.maxOf { (it.height + 8) * unit }
        val pixels = ByteArray(width * height) { 255.toByte() }
        var left = 0
        for (code in codes) {
            for (y in 0 until code.height) for (x in 0 until code.width) if (code.get(x, y).toInt() == 1) {
                for (dy in 0 until unit) for (dx in 0 until unit) pixels[((y + 4) * unit + dy) * width + left + (x + 4) * unit + dx] = 0
            }
            left += (code.width + 8) * unit
        }
        return Triple(pixels, width, height)
    }

    /* As a camera frame: 640 × 480, grey round it, the picture scaled, turned and smoothed by bilinear sampling. */
    private fun camera(picture: Triple<ByteArray, Int, Int>, scale: Double, turn: Double): ByteArray {
        val (pixels, width, height) = picture
        val cos = kotlin.math.cos(turn)
        val sin = kotlin.math.sin(turn)
        return ByteArray(640 * 480) { i ->
            val fx = (i % 640) - 320.0
            val fy = (i / 640) - 240.0
            val x = (cos * fx + sin * fy) / scale + width / 2.0
            val y = (-sin * fx + cos * fy) / scale + height / 2.0
            if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return@ByteArray 170.toByte()
            val x0 = x.toInt()
            val y0 = y.toInt()
            fun at(px: Int, py: Int) = pixels[py * width + px].toInt() and 0xff
            val top = at(x0, y0) * (1 - (x - x0)) + at(x0 + 1, y0) * (x - x0)
            val bottom = at(x0, y0 + 1) * (1 - (x - x0)) + at(x0 + 1, y0 + 1) * (x - x0)
            (top * (1 - (y - y0)) + bottom * (y - y0)).toInt().toByte()
        }
    }

    private fun approval(text: String) = text.startsWith("hushos-approve:")

    @Test
    fun everyRealRequestReadsCleanAndThroughACamera() {
        val random = java.util.Random(7)
        val missed = (0 until 300).map { request(random) }.flatMap { text ->
            val picture = drawn(listOf(text))
            listOfNotNull(
                "clean $text".takeIf { KitScan.decode(picture.first, picture.second, picture.third, accept = ::approval) != text },
                "camera $text".takeIf { KitScan.decode(camera(picture, 0.85, 0.12), 640, 480, accept = ::approval) != text },
            )
        }
        assertEquals(emptyList<String>(), missed)
    }

    @Test
    fun theRequestIsFoundBesideAnotherCode() {
        val text = request(java.util.Random(3))
        val (pixels, width, height) = drawn(listOf("https://hushos.com/s/5f0c2a9e-4b7d-4c1e-9a3b-2d8e6f1a7c40#k=abc", text), unit = 6)
        assertEquals(text, KitScan.decode(pixels, width, height, accept = ::approval))
        // Asked for something no code in the frame holds: nothing.
        assertNull(KitScan.decode(pixels, width, height) { it == "something else" })
    }
}

/*
 * The second read's caps (`KitScan.MOST_FINDERS`, `KitScan.MOST_SETS`): without them a sheet of
 * labels, or a screen tiled with finder squares, holds the camera thread for seconds or runs it out
 * of memory. Measured on clean frames, so the counts are exact: lifting either cap fails these.
 */
class KitScanCapTest {
    /* Small codes ("label-0", "label-1", …) tiled on a 640 × 480 frame, `unit` pixels a module, as many as fit. */
    private fun labels(count: Int, unit: Int): Pair<ByteArray, Int> {
        val pixels = ByteArray(640 * 480) { 255.toByte() }
        var left = 4
        var top = 4
        var placed = 0
        for (index in 0 until count) {
            val code = com.google.zxing.qrcode.encoder.Encoder.encode("label-$index", com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.L).matrix
            val side = (code.width + 4) * unit
            if (left + side > 640) {
                left = 4
                top += side
            }
            if (top + side > 480) break
            for (y in 0 until code.height) for (x in 0 until code.width) if (code.get(x, y).toInt() == 1) {
                for (dy in 0 until unit) for (dx in 0 until unit) pixels[(top + (y + 2) * unit + dy) * 640 + left + (x + 2) * unit + dx] = 0
            }
            left += side
            placed++
        }
        return pixels to placed
    }

    @Test
    fun aFrameOfManyCodesIsNotReadCodeByCode() {
        val (pixels, placed) = labels(15, 3)
        assertTrue("under the finder cap", placed * 3 < KitScan.MOST_FINDERS)
        var asks = 0
        assertNull(KitScan.decode(pixels, 640, 480) { asks++; false })
        // Every set tried would decode and offer each of the 15 codes; the first sets hold only a few.
        assertTrue("asked $asks times for $placed codes", asks < placed)
    }

    @Test
    fun aFrameWithMoreFindersThanTheCapGetsNoSecondRead() {
        val (pixels, placed) = labels(63, 2)
        assertTrue("over the finder cap", placed * 3 > KitScan.MOST_FINDERS)
        var asks = 0
        assertNull(KitScan.decode(pixels, 640, 480) { asks++; false })
        // Only the usual reader's code is offered: the finder search stops before any set is made.
        assertEquals(1, asks)
    }
}
