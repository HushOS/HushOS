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
    companion object {
        /* "Recover your account in the HushOS app" from a file picker's sign-in screen: recovery starts here, signed out. */
        const val RECOVER = "com.hushos.app.RECOVER"
        /* The picker's "Save your recovery words": the words and their check, unless a recovery is showing them already. */
        const val SHOW_WORDS = "com.hushos.app.SHOW_WORDS"
        /* "Create an account in the HushOS app" from a file picker's sign-in screen: sign-up starts here, signed out. */
        const val SIGN_UP = "com.hushos.app.SIGN_UP"
    }

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

    override fun onResume() {
        super.onResume()
        model.resumed()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /* Every window of HushOS gaining focus is when a sensitive clip that fell due can be read and cleared. */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) window.decorView.post { com.hushos.app.ui.SensitiveClipboard.sweep(this) }
    }

    /*
     * Links to this server (https) and hushos:// links arrive through LinkActivity, which hands them over
     * in memory (LinkHandoff), so this task's root intent never carries a link's key; the parsing and the
     * refusals live in AppLinks. A VIEW intent sent here directly is not opened.
     */
    private fun handle(intent: Intent?) {
        when (intent?.action) {
            LinkHandoff.OPEN -> { LinkHandoff.take()?.let(model::openLink); return }
            com.hushos.app.data.TransferQueue.OPEN_TRANSFERS -> { model.openRequest("transfers"); return }
            com.hushos.app.data.TransferNotices.OPEN_PHONE -> { model.openRequest("phone"); return }
            com.hushos.app.data.TransferNotices.OPEN_FILES -> { model.openRequest("files::"); return }
        }
        intent?.action?.takeIf { it.startsWith(com.hushos.app.data.TransferNotices.OPEN_FOLDER + ":") }?.let {
            model.openRequest("files:${it.removePrefix(com.hushos.app.data.TransferNotices.OPEN_FOLDER + ":")}:"); return
        }
        // Re-launched from Recents with the old intent: that link, shortcut or recovery was already opened (signed out,
        // Recents must bring back sign-in, not a recovery begun once from a picker).
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        when (intent.action) {
            RECOVER -> { model.recoverWhenSignedOut(); return }
            SIGN_UP -> { model.signUpWhenSignedOut(); return }
            SHOW_WORDS -> { if (model.recovery == null && model.signup == null) model.openRequest("words"); return }
        }
        // A launcher shortcut: the + menu's action (or Search), signed in or once signed in.
        intent.action?.takeIf { it.startsWith(SHORTCUT) }?.let { model.shortcut(it.removePrefix(SHORTCUT)) }
    }
}
