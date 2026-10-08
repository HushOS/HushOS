package com.hushos.app.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/*
 * "Keep downloaded": the app keeps a decrypted copy of a file in its private
 * storage, so it opens without the network, and remembers the names shown in
 * the Offline section on Home without a round trip.
 */
object Offline {
    /* `workspaceId` tells a file of this account's drive from one kept out of a share; entries kept before it was recorded have none. */
    data class Entry(
        val id: String, val name: String, val versionId: String, val size: Long?, val mime: String?, val keptAt: String, val workspaceId: String? = null,
        /* The kept folder that brought it here; it comes and goes with that folder, not on its own. */
        val via: String? = null,
    )

    /* A folder kept on this phone: every file in it and its subfolders, kept current as it changes. */
    data class Folder(
        val id: String, val name: String, val keptAt: String, val workspaceId: String,
        /* Kept out of a share: the share's root, so it is found through the share and goes when the share stops. */
        val shareRoot: String? = null,
    )

    private const val PREFS = "offline"
    private const val KEY = "entries"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun entries(context: Context): List<Entry> {
        val json = prefs(context).getString(KEY, null) ?: return emptyList()
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getJSONObject(it) }.map {
            Entry(it.getString("id"), it.getString("name"), it.getString("versionId"), if (it.isNull("size")) null else it.getLong("size"),
                if (it.isNull("mime")) null else it.getString("mime"), it.getString("keptAt"),
                if (it.isNull("workspaceId") || !it.has("workspaceId")) null else it.getString("workspaceId"),
                if (it.isNull("via") || !it.has("via")) null else it.getString("via"))
        }.sortedByDescending { it.keptAt }
    }

    /* The kept folders' record sits beside their files, so it goes wherever they go. */
    private fun foldersFile(context: Context) = File(root(context), "folders.json")

    fun folders(context: Context): List<Folder> {
        val array = runCatching { JSONArray(foldersFile(context).readText()) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getJSONObject(it) }
            .map { Folder(it.getString("id"), it.getString("name"), it.getString("keptAt"), it.getString("workspaceId"), if (it.isNull("shareRoot")) null else it.getString("shareRoot").ifEmpty { null }) }
            .sortedByDescending { it.keptAt }
    }

    private fun writeFolders(context: Context, list: List<Folder>) {
        val array = JSONArray()
        for (f in list) array.put(JSONObject().put("id", f.id).put("name", f.name).put("keptAt", f.keptAt).put("workspaceId", f.workspaceId)
            .put("shareRoot", f.shareRoot ?: JSONObject.NULL))
        root(context).mkdirs()
        foldersFile(context).writeText(array.toString())
    }

    fun isFolderKept(context: Context, id: String) = folders(context).any { it.id == id }

    /* The kept folder a file came with, if it came with one. */
    fun keptWith(context: Context, id: String): Folder? {
        val via = entries(context).firstOrNull { it.id == id }?.via ?: return null
        return folders(context).firstOrNull { it.id == via }
    }

    fun rememberFolder(context: Context, folder: Opened, shareRoot: String? = null) {
        val list = folders(context)
        val earlier = list.firstOrNull { it.id == folder.id }
        val share = shareRoot ?: earlier?.shareRoot
        if (earlier != null && earlier.name == folder.name && earlier.shareRoot == share) return
        writeFolders(context, list.filter { it.id != folder.id } + Folder(folder.id, folder.name, earlier?.keptAt ?: Instant.now().toString(), folder.node.workspaceId, share))
    }

    /* A kept folder off the phone: its record, every file that came with it, and their failures. */
    fun forgetFolder(context: Context, id: String) {
        writeFolders(context, folders(context).filter { it.id != id })
        for (entry in entries(context).filter { it.via == id }) forget(context, entry.id)
        writeFailures(context, failures(context).filter { it.folderId != id })
    }

    /* Files of kept folders that couldn't be kept, beside the folders' record. */
    private fun failuresFile(context: Context) = File(root(context), "failures.json")

    fun failures(context: Context): List<KeepFailure> {
        val array = runCatching { JSONArray(failuresFile(context).readText()) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getJSONObject(it) }.map {
            KeepFailure(it.getString("fileId"), it.getString("folderId"), it.getString("name"), it.getString("reason"), it.getInt("attempts"), it.getLong("nextAt"))
        }
    }

    private fun writeFailures(context: Context, list: List<KeepFailure>) {
        val array = JSONArray()
        for (f in list) array.put(JSONObject().put("fileId", f.fileId).put("folderId", f.folderId).put("name", f.name).put("reason", f.reason)
            .put("attempts", f.attempts).put("nextAt", f.nextAt))
        root(context).mkdirs()
        failuresFile(context).writeText(array.toString())
    }

    fun recordFailure(context: Context, failure: KeepFailure) =
        writeFailures(context, failures(context).filter { it.fileId != failure.fileId } + failure)

    fun clearFailure(context: Context, fileId: String) {
        val list = failures(context)
        if (list.any { it.fileId == fileId }) writeFailures(context, list.filter { it.fileId != fileId })
    }

    /* Retry asked for: the folder's failed files are tried in its next run. */
    fun retryFailures(context: Context, folderId: String) =
        writeFailures(context, failures(context).map { if (it.folderId == folderId) KeepRules.retryNow(it) else it })

    fun isKept(context: Context, id: String) = entries(context).any { it.id == id }

    private fun write(context: Context, list: List<Entry>) {
        val array = JSONArray()
        for (e in list) array.put(JSONObject().put("id", e.id).put("name", e.name).put("versionId", e.versionId)
            .put("size", e.size ?: JSONObject.NULL).put("mime", e.mime ?: JSONObject.NULL).put("keptAt", e.keptAt)
            .put("workspaceId", e.workspaceId ?: JSONObject.NULL).put("via", e.via ?: JSONObject.NULL))
        prefs(context).edit().putString(KEY, array.toString()).apply()
    }

    fun root(context: Context) = File(context.filesDir, "offline")

    /* Where a version's plaintext lives: one folder per version, so a replaced file never shows stale bytes. */
    fun file(context: Context, item: Opened): File? {
        val version = item.node.currentVersion ?: return null
        return File(File(File(root(context), item.id), version.id), item.name)
    }

    fun file(context: Context, entry: Entry): File = File(File(File(root(context), entry.id), entry.versionId), entry.name)

    /* The local copy, when it is the current version. */
    fun localCopy(context: Context, item: Opened): File? = file(context, item)?.takeIf { it.exists() }

    /* Whether this version is on the phone under any name: a rename elsewhere moves it, nothing comes down. */
    fun hasVersion(context: Context, item: Opened): Boolean {
        val version = item.node.currentVersion ?: return false
        return File(File(root(context), item.id), version.id).listFiles()?.any { it.isFile && !it.name.endsWith(".part") } == true
    }

    /* Records a kept file; `via` is the kept folder it comes with (a folder takes over a file kept on its own). */
    fun remember(context: Context, item: Opened, via: String? = null) {
        val earlier = entries(context).firstOrNull { it.id == item.id }
        val list = entries(context).filter { it.id != item.id } +
            Entry(item.id, item.name, item.node.currentVersion?.id ?: "", item.size, item.metadata.mime, earlier?.keptAt ?: Instant.now().toString(),
                item.node.workspaceId, via ?: earlier?.via)
        write(context, list)
    }

    /* Fills in the workspace of an entry kept before it was recorded, once the item is open. */
    fun recordWorkspace(context: Context, item: Opened) {
        val list = entries(context)
        if (list.none { it.id == item.id && it.workspaceId == null }) return
        write(context, list.map { if (it.id == item.id) it.copy(workspaceId = item.node.workspaceId) else it })
    }

    /* Every kept file and its entry: the account is leaving this phone (AccountStore). Written at once, before the next account signs in. */
    @android.annotation.SuppressLint("ApplySharedPref")
    fun clear(context: Context) {
        prefs(context).edit().clear().commit()
        root(context).deleteRecursively()
    }

    fun forget(context: Context, id: String) {
        write(context, entries(context).filter { it.id != id })
        File(root(context), id).deleteRecursively()
    }
}
