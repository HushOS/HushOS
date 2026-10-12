package com.hushos.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import java.util.concurrent.atomic.AtomicReference

/*
 * Every link from outside (a share link with its key after the #, the emailed recovery link with
 * its token, the app's own pages) lands here first, not in MainActivity. Opened cold, a VIEW intent
 * becomes its task's root and stays in Recents, and the system keeps that task's base intent, data
 * and all, across reboots. This activity has a task of its own that never shows in Recents and
 * leaves no history; it hands the link to MainActivity in memory, never in an intent, and finishes.
 */
class LinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString
        if (link != null) {
            LinkHandoff.put(link)
            startActivity(Intent(this, MainActivity::class.java).setAction(LinkHandoff.OPEN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }
}

/* One link on its way from LinkActivity to MainActivity, in this process only; taken once. */
object LinkHandoff {
    const val OPEN = "com.hushos.app.OPEN_LINK"
    private val pending = AtomicReference<String?>(null)

    fun put(link: String) = pending.set(link)
    fun take(): String? = pending.getAndSet(null)
}
