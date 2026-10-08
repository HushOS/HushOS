package com.hushos.app.data

import android.content.Context
import java.math.BigInteger

/*
 * A contact's fingerprint as twelve words, for reading aloud: the same mapping as
 * packages/crypto's fingerprintWords, so both people see the same words whichever
 * app they use. The fingerprint's first 132 bits, eleven at a time, most
 * significant first, each naming a word in the BIP-39 English list (a plain index,
 * no checksum). It must never change without a new version on every client.
 */
object Fingerprint {
    const val WORDS = 12

    fun words(fingerprint: String, wordlist: List<String>): List<String> {
        require(wordlist.size == 2048) { "The word list must have 2048 words." }
        val hex = fingerprint.replace(" ", "")
        require(Regex("^[0-9a-f]{40}$").matches(hex)) { "Invalid fingerprint." }
        var bits = BigInteger(hex, 16).shiftRight(28)
        val mask = BigInteger.valueOf(2047)
        val out = ArrayDeque<String>()
        repeat(WORDS) {
            out.addFirst(wordlist[bits.and(mask).toInt()])
            bits = bits.shiftRight(11)
        }
        return out.toList()
    }

    @Volatile private var list: List<String>? = null

    /* The BIP-39 English list shipped in res/raw, read once. */
    fun wordlist(context: Context): List<String> = list ?: context.resources.openRawResource(com.hushos.app.R.raw.bip39_english)
        .bufferedReader().readLines().filter { it.isNotBlank() }.also { list = it }
}
