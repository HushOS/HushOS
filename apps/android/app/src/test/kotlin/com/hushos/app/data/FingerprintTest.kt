package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.io.File

/*
 * Two people compare these words before one trusts the other's key, so Android
 * must draw exactly the words the web and iOS draw. The expected words come from
 * packages/crypto's fingerprintWords run on the same fingerprints.
 */
class FingerprintTest {
    private val wordlist = File("src/main/res/raw/bip39_english.txt").readLines().filter { it.isNotBlank() }

    @Test
    fun drawsTheSameWordsAsTheWeb() {
        assertEquals(
            "dish female aware black unhappy stage obscure cabin cart gossip faint finish",
            Fingerprint.words("3f2a 9c41 0b7e d5a8 6610 fe23 0c9d 47ab 81e0 5b3c", wordlist).joinToString(" "),
        )
        assertEquals(List(12) { "abandon" }, Fingerprint.words("0000 0000 0000 0000 0000 0000 0000 0000 0000 0000", wordlist))
        assertEquals(List(12) { "zoo" }, Fingerprint.words("ffff ffff ffff ffff ffff ffff ffff ffff ffff ffff", wordlist))
    }

    @Test
    fun aKeyOneBitApartReadsDifferently() {
        // A change inside the 132 bits the words cover must show in them.
        val a = Fingerprint.words("3f2a 9c41 0b7e d5a8 6610 fe23 0c9d 47ab 81e0 5b3c", wordlist)
        val b = Fingerprint.words("3f2a 9c41 0b7e d5a8 6610 fe23 0c9d 47ab 91e0 5b3c", wordlist)
        assertNotEquals(a, b)
        assertEquals("dish female aware black unhappy stage obscure cabin cart gossip faint fire", b.joinToString(" "))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAMalformedFingerprint() {
        Fingerprint.words("3f2a 9c41", wordlist)
    }
}
