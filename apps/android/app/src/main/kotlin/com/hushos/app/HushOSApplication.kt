package com.hushos.app

import android.app.Application
import com.hushos.app.data.DecryptedCopies
import com.hushos.app.data.TransferNotices

class HushOSApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Whether a HushOS screen is showing: finished transfers are notified only when none is.
        TransferNotices.watch(this)
        // A recovery the app was stopped in the middle of: a picker's sign-in waits until its new words are confirmed.
        com.hushos.app.data.RecoveryWords.load(this)
        // Every start of the process (the app, a queued job, the Files app's provider): plaintext copies older than a day go.
        val cache = cacheDir
        Thread({ runCatching { DecryptedCopies.sweep(cache) } }, "HushOSSweep").start()
    }
}
