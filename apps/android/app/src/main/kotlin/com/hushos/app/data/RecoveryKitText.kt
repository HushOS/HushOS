package com.hushos.app.data

/*
 * Reading a recovery kit back, as the web's apps/web/src/lib/recovery-kit.ts does: a kit
 * file this app or the web saved (the phrase is on the line after "The same phrase on one
 * line"), or a scanned code holding the kit's text or just the 24 words. Anything that
 * isn't one is refused before a word of it is used.
 */
object RecoveryKitText {
    const val WORDS = 24

    /* The words someone typed or pasted: lower case, any spacing, nothing empty. */
    fun wordsOf(text: String): List<String> = text.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

    private fun valid(words: List<String>) = words.size == WORDS && words.all { it.matches(Regex("^[a-z]+$")) }

    /* The phrase from a kit file: refused unless it starts as a kit does and the phrase line holds 24 plain words. */
    fun phraseFromKit(text: String): List<String>? {
        if (!text.trimStart().startsWith("HushOS recovery kit")) return null
        val lines = text.split(Regex("\\r?\\n"))
        val at = lines.indexOfFirst { it.startsWith("The same phrase on one line") }
        val words = if (at >= 0) lines.getOrNull(at + 1)?.let(::wordsOf).orEmpty() else emptyList()
        return words.takeIf(::valid)
    }

    /* What a scanned code holds: the kit's text, or the 24 words on their own. */
    fun phraseFromScan(text: String): List<String>? = phraseFromKit(text) ?: wordsOf(text).takeIf(::valid)

    /* Words that start with what is being typed, for completion; `wordlist` is BIP-39 English. */
    fun complete(prefix: String, wordlist: List<String>, limit: Int = 4): List<String> {
        val start = prefix.trim().lowercase()
        if (start.isEmpty()) return emptyList()
        return wordlist.filter { it.startsWith(start) }.take(limit)
    }
}
