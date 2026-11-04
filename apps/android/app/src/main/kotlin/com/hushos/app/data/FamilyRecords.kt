package com.hushos.app.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/*
 * What this phone keeps of each family it checked (iOS's FamilyRecords.swift, the web's `chains` store): the device record
 * the core sealed after an accepted member list (the chain cache and this device's own pin, under a key from the account
 * root, bound to the account and the family), and beside it only hints in the clear: the roster version the next fetch
 * continues from (a wrong one only makes the core fetch from version 1) and the family folders a wipe forgets. The joins
 * record, sealed by the core, sits beside it only between a first-use join's two steps.
 *
 * In `noBackupFilesDir/groups/`, one file per account and family, deleted on every wipe of the account (AccountStore).
 * The app and the DocumentsProvider share the process, so one lock serialises every write: records reach disk in commit
 * order, and a record never replaces one at a later roster version (an acceptance that finished late would otherwise put
 * back a record the next sync accepts a rollback from).
 */
class FamilyRecords(private val folder: File, private val generation: Long = GENERATION, private val open: () -> Boolean = { true }) {
    data class Row(val envelope: String, val rosterVersion: ULong, val areas: List<String>)

    class Unsaved : Refused("Nothing was changed", "This device couldn’t save its check of the family. Try again.")

    private fun file(userId: String, groupId: String, suffix: String): File? {
        if (!valid(userId.lowercase()) || !valid(groupId)) return null
        return File(folder, "${userId.lowercase()}_$groupId.$suffix")
    }

    /* The same store, writing and deleting only while `open` holds (its vault's session lasts), checked under the lock. */
    fun whileOpen(open: () -> Boolean) = FamilyRecords(folder, generation) { this.open() && open() }

    fun read(userId: String, groupId: String): Row? {
        val file = file(userId, groupId, "json") ?: return null
        return runCatching {
            val json = JSONObject(file.readText())
            val areas = json.getJSONArray("areas")
            Row(json.getString("envelope"), json.getLong("rosterVersion").toULong(), (0 until areas.length()).map { areas.getString(it) })
        }.getOrNull()
    }

    /*
     * Writes `row` unless a record at a later roster version is stored, comparing under the lock. False when it kept the
     * later one; throws when the write failed, since a record that may not be on disk must not be followed by a pin.
     */
    fun put(userId: String, groupId: String, row: Row): Boolean = synchronized(LOCK) {
        val file = file(userId, groupId, "json") ?: throw Unsaved()
        sameSession()
        read(userId, groupId)?.let { stored -> if (stored.rosterVersion > row.rosterVersion) return false }
        write(file, JSONObject().put("envelope", row.envelope).put("rosterVersion", row.rosterVersion.toLong()).put("areas", JSONArray(row.areas)).toString())
        true
    }

    fun delete(userId: String, groupId: String) = synchronized(LOCK) {
        // A session that ended (its vault closed, or a wipe since) deletes nothing: the record there may be the next one's.
        if (open() && GENERATION == generation) file(userId, groupId, "json")?.delete()
        Unit
    }

    /* The joins record (docs/optional-verification.md 3.3): kept between a first-use join's acceptance and its commit. */
    fun readJoins(userId: String, groupId: String): String? = file(userId, groupId, "joins")?.let { runCatching { it.readText() }.getOrNull() }?.ifEmpty { null }

    fun putJoins(userId: String, groupId: String, record: String) = synchronized(LOCK) {
        sameSession()
        write(file(userId, groupId, "joins") ?: throw Unsaved(), record)
    }

    /*
     * Under the lock a wipe takes too: a write of a session a sign-out (or any wipe) ended since this store was made writes
     * nothing, so a sync that resumes after the wipe never puts its record back on the signed-out phone.
     */
    private fun sameSession() { if (GENERATION != generation || !open()) throw Unsaved() }

    fun deleteJoins(userId: String, groupId: String) = synchronized(LOCK) {
        if (open() && GENERATION == generation) file(userId, groupId, "joins")?.delete()
        Unit
    }

    /* The families this account holds a device record of on this phone, by the files' names. */
    fun groups(userId: String): List<String> {
        val prefix = "${userId.lowercase()}_"
        return folder.list().orEmpty().mapNotNull { name ->
            if (!name.startsWith(prefix) || !name.endsWith(".json")) return@mapNotNull null
            name.removePrefix(prefix).removeSuffix(".json").takeIf(::valid)
        }
    }

    /* Written beside and moved over, so a crash mid-write never leaves half a record. */
    private fun write(file: File, text: String) {
        try {
            folder.mkdirs()
            val next = File(file.path + ".next")
            next.writeText(text)
            if (!next.renameTo(file)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw Unsaved()
        }
    }

    companion object {
        /* Process-wide, and the same lock family copies are cleaned under (FamilyCopies.LOCK): an ended vault's cleanup and the next one's writes are serialised. */
        private val LOCK get() = FamilyCopies.LOCK
        /* Moved by every wipe, under the lock: a store made before it writes nothing. */
        @Volatile private var GENERATION = 0L
        const val FOLDER = "groups"
        private val ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

        /* A lowercase UUID: the only thing a server-given id may be before it names a file or a path. */
        fun valid(id: String): Boolean = ID.matches(id)

        fun of(context: Context, open: () -> Boolean = { true }) = FamilyRecords(File(context.noBackupFilesDir, FOLDER), open = open)

        /* Every wipe of the account: under the lock, so a write holding it finishes first and is deleted. */
        fun deleteAll(noBackup: File) = synchronized(LOCK) {
            GENERATION++
            File(noBackup, FOLDER).deleteRecursively()
            Unit
        }
    }
}
