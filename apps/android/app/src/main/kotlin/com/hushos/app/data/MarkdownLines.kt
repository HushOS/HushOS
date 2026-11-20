package com.hushos.app.data

/*
 * The editor's Markdown preview by the source lines its blocks came from (MarkdownDocument.parseLined), as iOS's LineMap
 * and TextLines: block i covers the lines from its start up to the next block's, the blank lines after it included, and
 * the last runs to the end of the file. A position in either pane is a fractional source line (12.5: halfway down line
 * 12); the preview's is a block and how far down it.
 */
class LineMap(val starts: List<Double>, lines: Int) {
    /* One past the file's last line. */
    val end: Double = maxOf(lines + 1.0, (starts.lastOrNull() ?: 1.0) + 1)

    /* The block holding `line` and how far down it (0 at its first line, towards 1 at the next block's); null with no blocks. */
    fun place(line: Double): Pair<Int, Double>? {
        if (starts.isEmpty()) return null
        if (line < starts[0]) return 0 to 0.0
        var low = 0
        var high = starts.size - 1
        var found = 0
        while (low <= high) {
            val middle = (low + high) / 2
            if (starts[middle] <= line) { found = middle; low = middle + 1 } else high = middle - 1
        }
        val span = next(found) - starts[found]
        return found to if (span > 0) ((line - starts[found]) / span).coerceIn(0.0, 1.0) else 0.0
    }

    /* The source line at `fraction` of the way down block `index`: the inverse of place. */
    fun line(index: Int, fraction: Double): Double? {
        if (index !in starts.indices) return null
        return starts[index] + fraction.coerceIn(0.0, 1.0) * (next(index) - starts[index])
    }

    private fun next(index: Int) = if (index + 1 < starts.size) starts[index + 1] else end
}

/* Where each line of a text starts, in UTF-16 offsets (what an EditText counts in): a line by offset and back. */
class TextLines(text: CharSequence) {
    private val starts: IntArray

    init {
        val found = ArrayList<Int>().apply { add(0) }
        for (index in 0 until text.length) if (text[index] == '\n') found += index + 1
        starts = found.toIntArray()
    }

    val count: Int get() = starts.size

    /* The 1-based line holding `offset`. */
    fun lineAt(offset: Int): Int {
        var low = 0
        var high = starts.size - 1
        var found = 0
        while (low <= high) {
            val middle = (low + high) / 2
            if (starts[middle] <= offset) { found = middle; low = middle + 1 } else high = middle - 1
        }
        return found + 1
    }

    /* Where 1-based `line` starts, held to the text's lines. */
    fun startOf(line: Int): Int = starts[line.coerceIn(1, starts.size) - 1]
}
