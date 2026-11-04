package com.hushos.app.data

import android.content.Context

/*
 * The folder last added to: where Save to HushOS and the launcher shortcuts put things
 * next (falling back to Files when it is gone). An id and a name, both the account's,
 * so AccountStore forgets them with the rest.
 */
object Places {
    const val PREFS = "places"

    /* A folder; one in a family folder also names its family and the family folder's workspace (both or neither). */
    data class Folder(val id: String, val name: String, val groupId: String? = null, val workspaceId: String? = null) {
        val family: TransferQueue.Family? get() = if (groupId != null && workspaceId != null) TransferQueue.Family(groupId, workspaceId) else null
    }

    fun last(context: Context): Folder? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString("last-folder", null) ?: return null
        val groupId = prefs.getString("last-folder-group", null)
        val workspaceId = prefs.getString("last-folder-workspace", null)
        // Half a family's (an older write, a torn one) is no family folder: never taken for one of your own drive either.
        if ((groupId == null) != (workspaceId == null)) return null
        return Folder(id, prefs.getString("last-folder-name", null) ?: "Files", groupId, workspaceId)
    }

    fun used(context: Context, id: String, name: String) = used(context, Folder(id, name))

    fun used(context: Context, folder: Folder) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("last-folder", folder.id).putString("last-folder-name", folder.name)
            .putString("last-folder-group", folder.family?.groupId).putString("last-folder-workspace", folder.family?.workspaceId).apply()
    }

    fun forget(context: Context) {
        context.deleteSharedPreferences(PREFS)
    }
}
