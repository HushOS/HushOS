package com.hushos.app.data

import java.io.File

/*
 * Plaintext copies in the cache: files the Files app opened (files/) and edits it is writing back
 * (edits/), thumbnails from before they were piped (thumbnails/), files opened in another app
 * (opened/), from links (links/) or sent through the share sheet (share/), photos taken for upload
 * (camera/), and a copy across drives cut short (copy-*). They don't outlive a day: swept at every
 * process start, which is also when the Files app's provider first runs without the app. Kept files
 * (filesDir/offline) are not here. A family file's copy is under opened/family/<workspace>, so a removal
 * deletes every copy of that family folder, those an earlier session opened included.
 */
object DecryptedCopies {
    val FOLDERS = listOf("files", "thumbnails", "opened", "links", "share", "edits", "camera")
    /* A copy across drives works in cache/copy-<uuid> and removes it when done; one a crash left is swept like the rest. */
    const val COPY_PREFIX = "copy-"
    const val MAX_AGE_MS = 86_400_000L

    /* Removes every file under the folders older than a day, then the folders it leaves empty. */
    fun sweep(cache: File, now: Long = System.currentTimeMillis()) {
        val copies = cache.listFiles { file -> file.isDirectory && file.name.startsWith(COPY_PREFIX) }.orEmpty().map { it.name }
        for (name in FOLDERS + copies) {
            val root = File(cache, name)
            if (!root.isDirectory) continue
            root.walkBottomUp().forEach { entry ->
                when {
                    entry == root -> Unit
                    entry.isFile -> if (now - entry.lastModified() > MAX_AGE_MS) entry.delete()
                    entry.isDirectory -> if (entry.list()?.isEmpty() == true) entry.delete()
                }
            }
        }
    }
}

/*
 * Where a family file opened on this phone is copied: one folder per family workspace, under opened/ (the provider's
 * path and the sweep cover it, a sign-out clears it with the cache). A workspace id that isn't a UUID gets no folder.
 */
object FamilyCopies {
    /*
     * Process-wide: every vault's cleanup of family copies and records, a session's close, and a download's writes take it,
     * so an old vault's late cleanup and a new one's writes never interleave.
     */
    val LOCK = Any()

    fun folder(cache: File, workspaceId: String): File? =
        if (FamilyRecords.valid(workspaceId)) File(cache, "opened/family/${workspaceId.lowercase()}") else null

    /* What a family's clear leaves of these workspaces' copies: nothing. A folder the personal drive's id names holds none. */
    fun delete(cache: File, workspaceIds: Collection<String>) {
        for (id in workspaceIds) folder(cache, id)?.deleteRecursively()
    }
}
