package com.hushos.app.data

/*
 * Where each picked file's name lands in its destination folder, worked out per pick in
 * pick order, never by name: two picked files can share a name (chosen from different
 * folders), and each needs its own answer and its own name. iOS has the same rule.
 */
object UploadNames {
    sealed interface Placement {
        /* Nothing of this name is there: it goes under this name, its own or the next free one. */
        data class Free(val name: String) : Placement
        /* A file of this name (whatever its case) is there already, and the person is asked about it. */
        data object Clash : Placement
    }

    /*
     * For each picked name, in order: a clash when a file of that name is in the folder, else
     * free. A free name an earlier pick already took gets the next "(n)" name instead, so two
     * picked files never land under one name; there is nothing there to replace, so it isn't
     * asked about. `taken` holds every name in the folder (files and folders, lower case) and
     * gains the free names, for the kept-both names suggested next.
     */
    fun place(names: List<String>, existingFiles: List<String>, taken: MutableSet<String>): List<Placement> {
        val files = existingFiles.map { it.lowercase() }.toSet()
        // Only another pick moves a name on: a file may still share its name with a folder there.
        val picked = HashSet<String>()
        return names.map { name ->
            if (name.lowercase() in files) return@map Placement.Clash
            val free = if (name.lowercase() in picked) freeName(name, taken) else name
            picked.add(free.lowercase())
            taken.add(free.lowercase())
            Placement.Free(free)
        }
    }

    /* "report.pdf" becomes "report (2).pdf", then "(3)", until the name is free; `taken` is lower case. */
    fun freeName(name: String, taken: Set<String>): String {
        if (name.lowercase() !in taken) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        for (n in 2..999) { val candidate = "$stem ($n)$ext"; if (candidate.lowercase() !in taken) return candidate }
        return "$stem ${System.nanoTime() % 100000}$ext"
    }
}
