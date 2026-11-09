package com.hushos.app

import android.app.Application
import com.hushos.app.data.DecryptedCopies
import com.hushos.app.data.TransferNotices

class HushOSApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Whether a HushOS screen is showing: finished transfers are notified only when none is.
        TransferNotices.watch(this)
        // Phone notifications: Firebase set up from the build's own options (none in a build without them), before
        // FCM's service can run in this process.
        com.hushos.app.data.PushTokens.app(this)
        // A recovery the app was stopped in the middle of: a picker's sign-in waits until its new words are confirmed.
        com.hushos.app.data.RecoveryWords.load(this)
        // Every start of the process (the app, a queued job, the Files app's provider): plaintext copies older than a day go.
        val cache = cacheDir
        Thread({
            runCatching { DecryptedCopies.sweep(cache) }
            // Downloads a process died in the middle of (nothing of them was kept): gone, whoever they were for; one written
            // to in the last minutes may be this process's own, under way, and stays.
            runCatching {
                val idle = System.currentTimeMillis() - 10 * 60 * 1000L
                java.io.File(cache, com.hushos.app.files.HushOSDocumentsProvider.INCOMING).listFiles()?.filter { it.lastModified() < idle }?.forEach { it.delete() }
            }
            // Saves another app closed that weren't kept before the process stopped get their rows (an edit never closed and
            // over a day old is an open nobody holds any more, and goes), and a kept save whose job was never queued gets one.
            runCatching { com.hushos.app.data.TransferQueue.startupSweep(this) }
            // Relay handles a sign-out or a replaced token left to delete, until the relay confirms.
            runCatching { com.hushos.app.data.PushNotifications.registrar(this).drain() }
        }, "HushOSSweep").start()
    }
}
