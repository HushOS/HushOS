package com.hushos.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.hushos.app.ui.DriveViewModel
import com.hushos.app.ui.HushOSApp
import com.hushos.app.ui.HushOSTheme

private const val SHORTCUT = "com.hushos.app.shortcut."

class MainActivity : ComponentActivity() {
    private val model: DriveViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A link that started the app; not again when the activity is only recreated (rotation, dark mode).
        if (savedInstanceState == null) handle(intent)
        setContent {
            HushOSTheme { HushOSApp(model) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /* Links to this server (https) and hushos:// links; the parsing and the refusals live in AppLinks. */
    private fun handle(intent: Intent?) {
        when (intent?.action) {
            com.hushos.app.data.TransferQueue.OPEN_TRANSFERS -> { model.openRequest("transfers"); return }
            com.hushos.app.data.TransferNotices.OPEN_PHONE -> { model.openRequest("phone"); return }
            com.hushos.app.data.TransferNotices.OPEN_FILES -> { model.openRequest("files::"); return }
        }
        intent?.action?.takeIf { it.startsWith(com.hushos.app.data.TransferNotices.OPEN_FOLDER + ":") }?.let {
            model.openRequest("files:${it.removePrefix(com.hushos.app.data.TransferNotices.OPEN_FOLDER + ":")}:"); return
        }
        // Re-launched from Recents with the old intent: that link or shortcut was already opened.
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        // A launcher shortcut: the + menu's action (or Search), signed in or once signed in.
        intent.action?.takeIf { it.startsWith(SHORTCUT) }?.let { model.shortcut(it.removePrefix(SHORTCUT)); return }
        if (intent.action != Intent.ACTION_VIEW) return
        intent.dataString?.let(model::openLink)
    }
}
