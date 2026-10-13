package com.hushos.app.data

import java.io.File

/*
 * Plaintext copies in the cache: files the Files app opened (files/) and edits it is writing back
 * (edits/), thumbnails from before they were piped (thumbnails/), files opened in another app
 * (opened/), from links (links/) or sent through the share sheet (share/), photos taken for upload
 * (camera/), and a copy across drives cut short (copy-*). They don't outlive a day: swept at every
 * process start, which is also when the Files app's provider first runs without the app. Kept files
 * (filesDir/offline) are not here.
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
