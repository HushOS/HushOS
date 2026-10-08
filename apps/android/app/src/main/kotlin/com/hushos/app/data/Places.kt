package com.hushos.app.data

import android.content.Context

/*
 * The folder last added to: where Save to HushOS and the launcher shortcuts put things
 * next (falling back to Files when it is gone). An id and a name, both the account's,
 * so AccountStore forgets them with the rest.
 */
object Places {
    const val PREFS = "places"

    data class Folder(val id: String, val name: String)

    fun last(context: Context): Folder? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString("last-folder", null) ?: return null
        return Folder(id, prefs.getString("last-folder-name", null) ?: "Files")
    }

    fun used(context: Context, id: String, name: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("last-folder", id).putString("last-folder-name", name).apply()
    }

    fun forget(context: Context) {
        context.deleteSharedPreferences(PREFS)
    }
}
