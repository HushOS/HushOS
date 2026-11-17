package com.hushos.app.data

import com.hushos.core.ArchiveEntry
import java.time.LocalDateTime
import java.time.ZoneId

/*
 * The archive's list as folders (the web's treeOf in components/drive/archive-view.tsx): every
 * folder by its path ("" is the top), folders implied by a deeper path included, with how many
 * items each folder holds; Mac resource entries left out. Rows sort folders first, then by name,
 * numbers in order ("2" before "10").
 */
class ArchiveTree(entries: List<ArchiveEntry>) {
    sealed interface Row {
        val name: String
        data class Folder(override val name: String, val count: Int) : Row
        data class File(override val name: String, val entry: ArchiveEntry) : Row
    }

    private class Node {
        val folders = LinkedHashMap<String, Int>()
        val files = ArrayList<ArchiveEntry>()
    }

    private val nodes = HashMap<String, Node>()

    init {
        fun node(key: String) = nodes.getOrPut(key) { Node() }
        node("")
        for (entry in entries) {
            if (entry.hidden) continue
            val parts = entry.parts
            val depth = if (entry.directory) parts.size else parts.size - 1
            for (i in 0 until depth) {
                node(parts.subList(0, i).joinToString("/")).folders.putIfAbsent(parts[i], 0)
                node(parts.subList(0, i + 1).joinToString("/"))
            }
            if (!entry.directory && parts.isNotEmpty()) node(parts.dropLast(1).joinToString("/")).files.add(entry)
        }
        for ((key, value) in nodes) for (name in value.folders.keys.toList()) {
            val child = nodes[if (key.isEmpty()) name else "$key/$name"]!!
            value.folders[name] = child.folders.size + child.files.size
        }
    }

    /* The rows of the folder at `path` (its parts), empty for one the archive doesn't hold. */
    fun rows(path: List<String>): List<Row> {
        val node = nodes[path.joinToString("/")] ?: return emptyList()
        val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }
        val byName = Comparator<String> { a, b -> numberAware(a, b, collator) }
        val folders = node.folders.entries.sortedWith(compareBy(byName) { it.key }).map { Row.Folder(it.key, it.value) }
        val files = node.files.sortedWith(compareBy(byName) { it.parts.last() }).map { Row.File(it.parts.last(), it) }
        return folders + files
    }

    companion object {
        /* Runs of digits compare as numbers, the rest by the collator, as the web's Intl.Collator({ numeric: true }) does. */
        fun numberAware(a: String, b: String, collator: java.text.Collator): Int {
            val split = Regex("(\\d+)|(\\D+)")
            val left = split.findAll(a).map { it.value }.toList()
            val right = split.findAll(b).map { it.value }.toList()
            for (i in 0 until minOf(left.size, right.size)) {
                val x = left[i]
                val y = right[i]
                val result = if (x[0].isDigit() && y[0].isDigit()) {
                    x.trimStart('0').length.compareTo(y.trimStart('0').length).takeIf { it != 0 } ?: x.trimStart('0').compareTo(y.trimStart('0'))
                } else collator.compare(x, y)
                if (result != 0) return result
            }
            return left.size.compareTo(right.size)
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
