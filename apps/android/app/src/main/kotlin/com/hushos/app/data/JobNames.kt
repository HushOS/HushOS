package com.hushos.app.data

import android.content.Context
import org.json.JSONObject
import java.io.File

/*
 * The name of the file or folder each transfer job carries, kept by the app rather than in WorkManager's database: a
 * job's input, tags and output stay in that SQLite file (and its free pages) after the job is pruned, where sign-out
 * can't reach them. This file is the account's (AccountStore deletes it), and an entry goes once its job is gone.
 */
class JobNames(private val file: File, private val now: () -> Long = System::currentTimeMillis) {
    private fun read(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        val next = File(file.path + STAGED_SUFFIX)
        next.writeText(json.toString())
        if (!next.renameTo(file)) { file.writeText(json.toString()); next.delete() }
    }

    fun put(jobId: String, name: String) = synchronized(LOCK) {
        write(read().put(jobId, JSONObject().put("name", name).put("at", now())))
    }

    fun get(jobId: String): String? = synchronized(LOCK) { read().optJSONObject(jobId)?.optString("name")?.takeIf { it.isNotEmpty() } }

    fun all(): Map<String, String> = synchronized(LOCK) {
        val json = read()
        json.keys().asSequence().mapNotNull { id -> json.optJSONObject(id)?.optString("name")?.let { id to it } }.toMap()
    }

    /*
     * Keeps only the names of jobs WorkManager still has (`live`), and of jobs queued in the last ten minutes, which a
     * listing taken just before they were queued doesn't show yet.
     */
    fun retain(live: Set<String>) = synchronized(LOCK) {
        val json = read()
        val cutoff = now() - 10 * 60 * 1000
        val gone = json.keys().asSequence().filter { id -> id !in live && (json.optJSONObject(id)?.optLong("at") ?: 0L) < cutoff }.toList()
        if (gone.isNotEmpty()) write(json.apply { gone.forEach { remove(it) } })
    }

    companion object {
        private val LOCK = Any()
        const val FILE = "job-names.json"
        private const val STAGED_SUFFIX = ".next"
        /* Written beside and moved over: a write cut short leaves this, names and all, for the wipe to delete too. */
        const val STAGED = FILE + STAGED_SUFFIX

        fun of(context: Context) = JobNames(File(context.filesDir, FILE))
    }
}
