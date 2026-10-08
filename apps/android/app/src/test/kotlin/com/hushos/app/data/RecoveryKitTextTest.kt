package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
