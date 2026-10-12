package com.hushos.app.data

import android.content.Context
import com.hushos.core.keyDigest
import org.json.JSONObject
import java.io.File

class SettingsRolledBack : Refused("Nothing was changed", "The server sent older settings than this device has seen. Nothing was changed.")

/*
 * The newest settings version this device has seen, per account and identity. The server keeps
 * the settings and could hand back an older copy, or none, to bring back a pin the person replaced
 * or drop the sharing ledger; a device that has seen version n refuses anything older. A new
 * identity starts its own count. Kept outside AccountStore's wipe on purpose: a sign-out and a
 * sign-in again must still catch a rollback. Entries are named by a digest, not the user id.
 */
class SettingsMark(private val file: File) {
    private fun read(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    fun seen(key: String): ULong = synchronized(LOCK) { read().optLong(key, 0L).coerceAtLeast(0L).toULong() }

    /* Refuses a served version older than the mark, or no document at all once one was seen. */
    fun check(key: String, served: ULong?) {
        val seen = seen(key)
        if (seen > 0uL && (served == null || served < seen)) throw SettingsRolledBack()
    }

    /* Raises the mark to `version`; never lowers it. */
    fun record(key: String, version: ULong) {
        synchronized(LOCK) {
            val json = read()
            if (version <= json.optLong(key, 0L).coerceAtLeast(0L).toULong()) return
            json.put(key, version.toLong())
            file.parentFile?.mkdirs()
            // Written beside and moved over, so a crash mid-write never leaves a mark of zero.
            val next = File(file.path + ".next")
            next.writeText(json.toString())
            if (!next.renameTo(file)) { file.writeText(json.toString()); next.delete() }
        }
    }

    companion object {
        private val LOCK = Any()

        /* In noBackupFilesDir: device-local by definition, and not one of the account's files a sign-out removes. */
        fun of(context: Context) = SettingsMark(File(context.noBackupFilesDir, "settings-seen.json"))

        fun key(userId: String, encryptionPublicKey: String): String = keyDigest("${userId.lowercase()}\n$encryptionPublicKey".toByteArray(Charsets.UTF_8))
    }
}
