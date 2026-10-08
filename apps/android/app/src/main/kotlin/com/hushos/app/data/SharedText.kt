package com.hushos.app.data

/*
 * Text shared to Save to HushOS with no file attached: a browser's page (its link, with the
 * page title as the subject) or a few lines from a note. It is saved as a small .txt named
 * after the title, holding the title and the link, so it opens anywhere.
 */
object SharedText {
    private val URL = Regex("""https?://[^\s<>"]+""", RegexOption.IGNORE_CASE)

    data class Saved(val name: String, val body: String, val link: Boolean)

    fun of(text: String?, subject: String?): Saved? {
        val shared = text?.trim().orEmpty()
        if (shared.isEmpty()) return null
        val url = URL.find(shared)?.value?.trimEnd('.', ',', ';', '!', '?')
        if (url != null) {
            // Chrome sends the page title as the subject; other apps put it beside the link.
            val beside = shared.replace(url, " ").trim().trim('-', '–', '—', ':', '|', '"', '“', '”').trim()
            val title = subject?.trim()?.takeIf { it.isNotEmpty() && it != url }
                ?: beside.takeIf { it.isNotEmpty() && it.length <= 200 && !it.contains('\n') }
                ?: host(url)
            return Saved(fileName(title, "Link"), "$title\n$url\n", link = true)
        }
        val title = subject?.trim()?.takeIf { it.isNotEmpty() } ?: shared.lineSequence().first().take(60)
        return Saved(fileName(title, "Note"), shared + "\n", link = false)
    }

    private fun host(url: String) = runCatching { java.net.URI(url).host?.removePrefix("www.") }.getOrNull() ?: "Link"

    /* A title as a file name: no characters a drive or a phone refuses, not too long, never empty. */
    fun fileName(title: String, fallback: String): String {
        val clean = title.replace(Regex("""[\\/:*?"<>|\p{Cntrl}]"""), " ").replace(Regex("""\s+"""), " ").trim().trim('.').take(80).trim()
        return clean.ifEmpty { fallback } + ".txt"
    }
}
