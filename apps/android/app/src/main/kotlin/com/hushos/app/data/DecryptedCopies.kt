package com.hushos.app.data

import java.io.File

/*
 * Decrypted copies in the cache: files the Files app opened (files/), thumbnails from before they
 * were piped (thumbnails/), files opened in another app (opened/) and from links (links/). They are
 * plaintext, so they don't outlive a day: swept at every process start, which is also when the
 * Files app's provider first runs without the app. Kept files (filesDir/offline) are not here.
 */
object DecryptedCopies {
    val FOLDERS = listOf("files", "thumbnails", "opened", "links")
    const val MAX_AGE_MS = 86_400_000L

    /* Removes every file under the folders older than a day, then the folders it leaves empty. */
    fun sweep(cache: File, now: Long = System.currentTimeMillis()) {
        for (name in FOLDERS) {
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
