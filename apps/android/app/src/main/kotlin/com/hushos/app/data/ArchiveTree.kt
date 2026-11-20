package com.hushos.app.data

import com.hushos.core.ArchiveEntry
import com.hushos.core.ArchiveFolders
import java.time.LocalDateTime
import java.time.ZoneId

/*
 * The archive's list as folders (the web's rowsOf in components/drive/viewers/archive-view.tsx), from the
 * core's ArchiveFolders: each folder's parent and name in one array and one string, never an
 * object a folder, so a listing of millions of folders costs a few bytes each. A folder's rows
 * (its folders first, then its files, each by name, numbers in order: "2" before "10") are made
 * the first time they are asked for, off the main thread (a folder of 100,000 files takes seconds
 * to sort), and kept: `made` hands back the ones already made without waiting on a sort under way.
 * Mac resource entries are left out.
 */
class ArchiveTree(entries: List<ArchiveEntry>, folders: ArchiveFolders) {
    sealed interface Row {
        val name: String
        /* A folder: its number in the list's folders, and how many items it holds. */
        data class Folder(val id: Int, override val name: String, val count: Int) : Row
        data class File(override val name: String, val entry: ArchiveEntry) : Row
    }

    private val parents: IntArray = java.nio.ByteBuffer.wrap(folders.parents).order(java.nio.ByteOrder.LITTLE_ENDIAN).asIntBuffer()
        .let { buffer -> IntArray(maxOf(buffer.remaining(), 1)).also { buffer.get(it, 0, buffer.remaining()) } }
    private val names = folders.names
    /* Where each folder's name starts in `names`; the next one's start, less its `/`, is where it ends. */
    private val starts = IntArray(parents.size + 1).also { starts ->
        var at = 0
        for (k in 1 until parents.size) {
            starts[k] = at
            at = names.indexOf('/', at).let { if (it < 0) names.length else it + 1 }
        }
        starts[parents.size] = at
    }
    private val files = entries.filter { !it.hidden && !it.directory && it.folder.toInt() < parents.size }
    /* What each folder holds, folders and files. */
    private val counts = IntArray(parents.size).also { counts ->
        for (k in 1 until parents.size) counts[parents[k]]++
        for (file in files) counts[file.folder.toInt()]++
    }
    private val kept = java.util.concurrent.ConcurrentHashMap<Int, List<Row>>()

    /* Folder `id`'s name ("" for the top). */
    fun name(id: Int): String = if (id <= 0 || id >= parents.size) "" else names.substring(starts[id], starts[id + 1] - 1)

    /* The rows of folder `id` (0: the top), empty for one the list doesn't hold. */
    fun rows(id: Int): List<Row> {
        kept[id]?.let { return it }
        if (id < 0 || id >= parents.size) return emptyList()
        // A collator of its own: two folders may sort at once (each off the main thread), and an ICU collator isn't safe across threads.
        val collator = this.collator.clone() as java.text.Collator
        val byName = Comparator<String> { a, b -> numberAware(a, b, collator) }
        val inside = ArrayList<Row.Folder>()
        for (k in 1 until parents.size) if (parents[k] == id) inside.add(Row.Folder(k, name(k), counts[k]))
        val folderRows = inside.sortedWith(compareBy(byName) { it.name })
        val fileRows = files.filter { it.folder.toInt() == id }.sortedWith(compareBy(byName) { it.name }).map { Row.File(it.name, it) }
        return kept.putIfAbsent(id, folderRows + fileRows) ?: kept.getValue(id)
    }

    /* Folder `id`'s rows when they are made already, else null: never sorts. */
    fun made(id: Int): List<Row>? = kept[id]

    private val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }

    companion object {
        /*
         * Runs of digits compare as numbers, the rest by the collator, as the web's
         * Intl.Collator({ numeric: true }) does. A total order, so a sort never finds it broken: a
         * name is a sequence of runs, each a number (Unicode decimal digits, full-width ones too,
         * by their values) or not (by the collator), and where one name has a number and the other
         * doesn't, the number comes first, whatever the collator would make of a ² or a ①.
         * Scanned in place: no pattern or list per comparison.
         */
        fun numberAware(a: String, b: String, collator: java.text.Collator): Int {
            var i = 0
            var j = 0
            while (i < a.length && j < b.length) {
                val digitsA = Character.isDigit(a[i])
                val digitsB = Character.isDigit(b[j])
                var endA = i
                while (endA < a.length && Character.isDigit(a[endA]) == digitsA) endA++
                var endB = j
                while (endB < b.length && Character.isDigit(b[endB]) == digitsB) endB++
                val result = when {
                    digitsA && digitsB -> {
                        var x = i
                        while (x < endA - 1 && Character.digit(a[x], 10) == 0) x++
                        var y = j
                        while (y < endB - 1 && Character.digit(b[y], 10) == 0) y++
                        val lengths = (endA - x).compareTo(endB - y)
                        if (lengths != 0) lengths else {
                            var order = 0
                            while (order == 0 && x < endA) order = Character.digit(a[x++], 10).compareTo(Character.digit(b[y++], 10))
                            order
                        }
                    }
                    digitsA -> -1
                    digitsB -> 1
                    else -> collator.compare(a.substring(i, endA), b.substring(j, endB))
                }
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
