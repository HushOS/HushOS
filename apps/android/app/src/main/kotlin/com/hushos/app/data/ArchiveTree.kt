package com.hushos.app.data

import com.hushos.core.ArchiveEntry
import java.time.LocalDateTime
import java.time.ZoneId

/*
 * The archive's list as folders (the web's treeOf in components/drive/archive-view.tsx): a tree
 * whose nodes hold only their own children, folders implied by a deeper path included, so memory
 * grows with the entries' parts, never with every prefix of every path (the core caps a path at
 * 256 parts). Mac resource entries are left out. Rows sort folders first, then by name, numbers in
 * order ("2" before "10"), once per folder and kept.
 */
class ArchiveTree(entries: List<ArchiveEntry>) {
    sealed interface Row {
        val name: String
        data class Folder(override val name: String, val count: Int) : Row
        data class File(override val name: String, val entry: ArchiveEntry) : Row
    }

    private class Node {
        val folders = LinkedHashMap<String, Node>()
        val files = ArrayList<ArchiveEntry>()
        /* The rows, sorted the first time they are asked for. */
        var rows: List<Row>? = null
    }

    private val top = Node()

    init {
        for (entry in entries) {
            if (entry.hidden) continue
            val parts = entry.parts
            val depth = if (entry.directory) parts.size else parts.size - 1
            var node = top
            for (i in 0 until depth) node = node.folders.getOrPut(parts[i]) { Node() }
            if (!entry.directory && parts.isNotEmpty()) node.files.add(entry)
        }
    }

    /* The rows of the folder at `path` (its parts), empty for one the archive doesn't hold. */
    fun rows(path: List<String>): List<Row> {
        var node: Node = top
        for (part in path) node = node.folders[part] ?: return emptyList()
        node.rows?.let { return it }
        val byName = Comparator<String> { a, b -> numberAware(a, b, collator) }
        val folders = node.folders.entries.sortedWith(compareBy(byName) { it.key })
            .map { Row.Folder(it.key, it.value.folders.size + it.value.files.size) }
        val files = node.files.sortedWith(compareBy(byName) { it.parts.last() }).map { Row.File(it.parts.last(), it) }
        return (folders + files).also { node.rows = it }
    }

    private val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }

    companion object {
        /*
         * Runs of digits compare as numbers, the rest by the collator, as the web's
         * Intl.Collator({ numeric: true }) does. Scanned in place: no pattern or list per comparison.
         */
        fun numberAware(a: String, b: String, collator: java.text.Collator): Int {
            var i = 0
            var j = 0
            while (i < a.length && j < b.length) {
                val digitsA = a[i].isDigit()
                val digitsB = b[j].isDigit()
                var endA = i
                while (endA < a.length && a[endA].isDigit() == digitsA) endA++
                var endB = j
                while (endB < b.length && b[endB].isDigit() == digitsB) endB++
                val result = if (digitsA && digitsB) {
                    var x = i
                    while (x < endA - 1 && a[x] == '0') x++
                    var y = j
                    while (y < endB - 1 && b[y] == '0') y++
                    val lengths = (endA - x).compareTo(endB - y)
                    if (lengths != 0) lengths else a.substring(x, endA).compareTo(b.substring(y, endB))
                } else collator.compare(a.substring(i, endA), b.substring(j, endB))
                if (result != 0) return result
                i = endA
                j = endB
            }
            // The one with runs left after the other is done sorts after it.
            return if (i >= a.length && j >= b.length) 0 else if (i >= a.length) -1 else 1
        }

        /* When the entry last changed: its Unix time when the archive kept one, else its MS-DOS date and time on this phone's clock. */
        fun modifiedMillis(entry: ArchiveEntry, zone: ZoneId = ZoneId.systemDefault()): Long? {
            entry.mtimeMillis?.let { return it }
            val dos = entry.dos.toLong()
            val date = (dos ushr 16).toInt()
            val time = (dos and 0xffff).toInt()
            val month = (date shr 5) and 0xf
            val day = date and 0x1f
            if (month == 0 || day == 0) return null
            return runCatching {
                LocalDateTime.of(((date shr 9) and 0x7f) + 1980, month, day, time shr 11, (time shr 5) and 0x3f, (time and 0x1f) * 2)
                    .atZone(zone).toInstant().toEpochMilli()
            }.getOrNull()
        }

        /* What an entry previews as, by its name, for the large-file card's limits (zipEntryPreviewLimits). */
        fun previewKind(name: String): String {
            val ext = name.substringAfterLast('.', "").lowercase()
            return when {
                ext in IMAGE -> "image"
                ext == "pdf" -> "pdf"
                MarkdownDocument.handles(name, null) || ext in TEXT -> "text"
                else -> "other"
            }
        }

        val IMAGE = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif")
        val TEXT = setOf(
            "txt", "json", "csv", "tsv", "log", "xml", "yaml", "yml", "toml", "ini", "env", "sh", "js", "mjs", "ts", "tsx", "jsx",
            "css", "html", "htm", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sql",
        )

        /* A zip, which opens as its list in the app rather than going to another app. */
        fun isZip(name: String, mime: String?): Boolean {
            val type = mime?.substringBefore(';')?.trim()?.lowercase()
            return type == "application/zip" || type == "application/x-zip-compressed" || name.substringAfterLast('.', "").lowercase() == "zip"
        }
    }
}
