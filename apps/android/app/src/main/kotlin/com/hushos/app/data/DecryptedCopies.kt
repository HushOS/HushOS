package com.hushos.app.data

import java.io.File

/*
 * Plaintext copies in the cache: files the Files app opened (files/) and edits it is writing back
 * (edits/), thumbnails from before they were piped (thumbnails/), files opened in another app
 * (opened/), from links (links/) or sent through the share sheet (share/), photos taken for upload
 * (camera/), and a copy across drives cut short (copy-*). They don't outlive a day: swept at every
 * process start, which is also when the Files app's provider first runs without the app. Kept files
 * (filesDir/offline) are not here. A family file's copy is under opened/family/<workspace>, so a removal
 * deletes every copy of that family folder, those an earlier session opened included; a received share's is under
 * opened/share/<workspace>, so a proof that its folder is a family's deletes them all the same way. Only this account's
 * own drive's copies are under opened/<node>.
 */
object DecryptedCopies {
    val FOLDERS = listOf("files", "thumbnails", "opened", "links", "share", "edits", "camera")
    /* A copy across drives works in cache/copy-<uuid> and removes it when done; one a crash left is swept like the rest. */
    const val COPY_PREFIX = "copy-"
    const val MAX_AGE_MS = 86_400_000L

    /*
     * Removes every file under the folders older than a day, then the folders it leaves empty. A copy across drives a
     * stopped process left (copy-*) goes whole whatever its age: run as the process starts, none of them is this one's,
     * and its plaintext (a received share's, maybe) sits under no workspace a proof or a removal looks in.
     */
    fun sweep(cache: File, now: Long = System.currentTimeMillis()) {
        for (left in cache.listFiles { file -> file.isDirectory && file.name.startsWith(COPY_PREFIX) }.orEmpty()) left.deleteRecursively()
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

/*
 * Where a family file opened on this phone is copied: one folder per family workspace, under opened/ (the provider's
 * path and the sweep cover it, a sign-out clears it with the cache). A workspace id that isn't a UUID gets no folder.
 */
object ShareCopies {
    /* A received share's copies, one folder per workspace (none for a workspace id that isn't a UUID). */
    fun folder(cache: File, workspaceId: String): File? =
        if (FamilyRecords.valid(workspaceId.lowercase())) File(cache, "opened/share/${workspaceId.lowercase()}") else null
}

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
