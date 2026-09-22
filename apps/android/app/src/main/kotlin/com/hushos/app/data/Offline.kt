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
    data class Entry(val id: String, val name: String, val versionId: String, val size: Long?, val mime: String?, val keptAt: String)

    private const val PREFS = "offline"
    private const val KEY = "entries"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun entries(context: Context): List<Entry> {
        val json = prefs(context).getString(KEY, null) ?: return emptyList()
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getJSONObject(it) }.map {
            Entry(it.getString("id"), it.getString("name"), it.getString("versionId"), if (it.isNull("size")) null else it.getLong("size"),
                if (it.isNull("mime")) null else it.getString("mime"), it.getString("keptAt"))
        }.sortedByDescending { it.keptAt }
    }

    fun isKept(context: Context, id: String) = entries(context).any { it.id == id }

    private fun write(context: Context, list: List<Entry>) {
        val array = JSONArray()
        for (e in list) array.put(JSONObject().put("id", e.id).put("name", e.name).put("versionId", e.versionId)
            .put("size", e.size ?: JSONObject.NULL).put("mime", e.mime ?: JSONObject.NULL).put("keptAt", e.keptAt))
        prefs(context).edit().putString(KEY, array.toString()).apply()
    }

    private fun root(context: Context) = File(context.filesDir, "offline")

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

    fun remember(context: Context, item: Opened) {
        val list = entries(context).filter { it.id != item.id } +
            Entry(item.id, item.name, item.node.currentVersion?.id ?: "", item.size, item.metadata.mime, Instant.now().toString())
        write(context, list)
    }

    fun forget(context: Context, id: String) {
        write(context, entries(context).filter { it.id != id })
        File(root(context), id).deleteRecursively()
    }
}
