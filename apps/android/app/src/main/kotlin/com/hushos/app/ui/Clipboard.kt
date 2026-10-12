package com.hushos.app.ui

import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.security.MessageDigest

/*
 * Sensitive clips (a link with its key, the recovery phrase) leave the clipboard after two
 * minutes, as on iOS, when the clipboard still holds them: something copied since is left alone.
 * Android lets an app read the clipboard only while it has focus, so a check that falls due
 * while HushOS is in the background waits for the next time a HushOS window gains focus
 * (MainActivity calls `sweep`). Only a digest of the text is kept for the comparison.
 */
internal object SensitiveClipboard {
    const val CLEAR_AFTER_MS = 120_000L

    private class Pending(val digest: String, val due: Long)
    private val pending = ArrayList<Pending>()
    private val main = Handler(Looper.getMainLooper())

    /* Copies `text` marked sensitive and schedules its removal. */
    fun copy(context: Context, label: String, text: String) {
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(sensitiveClip(label, text))
        watch(context, text)
    }

    /*
     * Schedules the removal of `text` if anything puts it on the clipboard: a copy made here, or the
     * system share sheet's own Copy when a link is sent (which HushOS can't mark or stop).
     */
    fun watch(context: Context, text: String) {
        val app = context.applicationContext
        synchronized(pending) { pending.add(Pending(digest(text), System.currentTimeMillis() + CLEAR_AFTER_MS)) }
        main.postDelayed({ sweep(app) }, CLEAR_AFTER_MS)
    }

    /* Clears the clipboard when it holds a sensitive clip that is due; checks that can't read the clipboard yet stay pending. */
    fun sweep(context: Context) {
        val now = System.currentTimeMillis()
        val due = synchronized(pending) { pending.filter { it.due <= now } }
        if (due.isEmpty()) return
        val manager = context.getSystemService(ClipboardManager::class.java)
        // Null without focus (Android 10 and later), which can't be told from an empty clipboard: nothing is
        // compared or cleared, and the check waits for focus. After a day it is dropped, empty clipboard or not.
        val clip = runCatching { manager.primaryClip }.getOrNull()
        if (clip == null) {
            synchronized(pending) { pending.removeAll { now - it.due > 86_400_000L } }
            return
        }
        val held = if (clip.itemCount == 1) clip.getItemAt(0).text?.toString()?.let(::digest) else null
        if (held != null && due.any { it.digest == held }) {
            runCatching { manager.clearPrimaryClip() }
        }
        // Done either way: the clip is gone, or something else replaced it.
        synchronized(pending) { pending.removeAll(due.toSet()) }
    }

    private fun digest(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
