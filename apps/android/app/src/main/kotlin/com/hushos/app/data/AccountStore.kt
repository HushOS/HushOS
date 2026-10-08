package com.hushos.app.data

import android.content.Context
import java.io.File

/*
 * Everything this phone holds for one account: decrypted files kept on the phone,
 * files opened or fetched for the Files app, decrypted thumbnails, the parents index,
 * the transfer queue's copies, the tree mirror, recent searches. It belongs to the
 * account that signed in, recorded by user id, and goes on sign-out, on account
 * deletion, and before a different account signs in, so nothing of one account ever
 * shows to the next (Home, On this phone, search, the Files app).
 *
 * The files are plain directories so a JVM test can hold the rule to them; what lives
 * in preferences and SQLite goes through `forgetStores`.
 */
class AccountStore(private val files: File, private val cache: File, private val forgetStores: () -> Unit = {}) {
    private val ownerFile = File(files, "account-owner")

    /* The account whose data is on the phone, or null when none is recorded. */
    fun owner(): String? = ownerFile.takeIf { it.exists() }?.readText()?.trim()?.ifEmpty { null }

    /*
     * Before `userId` signs in: another account's data, or data nobody is recorded as
     * owning (kept before this store existed), is removed first. The same account
     * signing in again (after its session ended) keeps what it kept.
     */
    fun claim(userId: String) {
        val owner = owner()
        if (owner == null || !owner.equals(userId, ignoreCase = true)) wipe()
        files.mkdirs()
        ownerFile.writeText(userId)
    }

    /* A session already signed in when this store first runs: its data is its own. */
    fun adopt(userId: String) {
        if (owner() == null) { files.mkdirs(); ownerFile.writeText(userId) }
    }

    /* Sign-out and account deletion: every account file, decrypted or not, and the owner. */
    fun wipe() {
        for (name in ACCOUNT_FILES) File(files, name).deleteRecursively()
        // The cache is all account data (opened files, links, the Files app's copies and
        // thumbnails, staged uploads, photos, the recovery kit) except JNA's native library.
        cache.listFiles()?.filterNot { it.name.startsWith("jna") }?.forEach { it.deleteRecursively() }
        forgetStores()
        ownerFile.delete()
    }

    companion object {
        /* Under filesDir: kept files, the upload queue's copies, the node-to-parent index, failed transfers and the ones awaiting a notification. */
        private val ACCOUNT_FILES = listOf("offline", "queue", "files-parents.json", FailedTransfers.FILE, TransferNotices.OUTCOMES)

        fun of(context: Context): AccountStore = AccountStore(context.filesDir, context.cacheDir) {
            // Jobs queued for that account would run under the next one's session.
            androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(TransferQueue.TAG)
            // Finished jobs keep their names in WorkManager's records; failed ones stay on the panel until dealt with,
            // so they go here too, or the next account would see them.
            androidx.work.WorkManager.getInstance(context).pruneWork()
            Offline.clear(context)
            // Finished-transfer notifications name the account's files.
            TransferNotices.clear(context)
            // The folder last added to (Save to HushOS and the shortcuts start there).
            Places.forget(context)
            Mirror.shared(context).clear()
            // Recent searches, one store per account.
            File(context.applicationInfo.dataDir, "shared_prefs").listFiles()
                ?.filter { it.name.startsWith("search-") && it.name.endsWith(".xml") }
                ?.forEach { context.deleteSharedPreferences(it.name.removeSuffix(".xml")) }
        }
    }
}
