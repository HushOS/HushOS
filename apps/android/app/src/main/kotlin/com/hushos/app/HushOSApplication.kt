package com.hushos.app

import android.app.Application
import com.hushos.app.data.TransferNotices

class HushOSApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Whether a HushOS screen is showing: finished transfers are notified only when none is.
        TransferNotices.watch(this)
    }
}
