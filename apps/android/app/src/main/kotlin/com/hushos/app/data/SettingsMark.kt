package com.hushos.app.data

import android.content.Context
import com.hushos.core.keyDigest
import org.json.JSONObject
import java.io.File

class SettingsRolledBack : Refused("Nothing was changed", "The server sent older settings than this device has seen. Nothing was changed.")

class IdentityRolledBack : Refused("Nothing was changed", "The server sent older sharing keys than this device has used. Nothing was changed.")

/*
 * High-water marks this device keeps against a server that serves something older (docs/integrity-design.md,
 * "Rollback marks"): the newest settings version seen, and the highest own identity key version opened, each per
 * account. The server keeps both and could hand back an older settings document (a pin the person replaced, a ledger
 * with a share they stopped) or none at all, or an identity the account replaced. A mark only ever rises, and a
 * succession does not reset it: the settings are the account's, not an identity's. Kept outside AccountStore's wipe on
 * purpose: a sign-out and a sign-in again must still catch a rollback. Entries are named by a digest, not the user id.
 * A new device has no marks; that is inherent.
 */
class SettingsMark(private val file: File) {
    private fun read(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    fun seen(key: String): ULong = synchronized(LOCK) { read().optLong(key, 0L).coerceAtLeast(0L).toULong() }

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

    /*
     * The settings mark for this account, carrying over what an earlier app kept per identity (named by the identity's
     * encryption key): the higher of the two counts, so moving to a per-account mark never lowers it.
     */
    fun settingsSeen(userId: String, legacyEncryptionPublicKey: String?): ULong {
        val key = key(userId)
        legacyEncryptionPublicKey?.let { record(key, seen(legacyKey(userId, it))) }
        return seen(key)
    }

    /*
     * The settings the server serves now, against this account's marks. `sequence` is the stored settings sequence,
     * which the server serves with or without a document: below the newest this device has seen is a rollback,
     * document or not. No document at a sequence at or above the mark is a version 1 row (served as none, since no
     * client opens those any more), unless this device has seen a version 2 document: those are never served as none.
     */
    fun checkSettings(userId: String, sequence: ULong, present: Boolean) {
        if (sequence < seen(key(userId))) throw SettingsRolledBack()
        if (!present && seen(v2Key(userId)) > 0uL) throw SettingsRolledBack()
    }

    /* Raises the account's settings mark; `sealedV2` also raises the mark that makes "none" a rollback. */
    fun recordSettings(userId: String, version: ULong, sealedV2: Boolean) {
        record(key(userId), version)
        if (sealedV2) record(v2Key(userId), version)
    }

    /*
     * An own identity served as current: refused before it is opened when its key version is lower than one this
     * device already opened (an identity the account replaced, served again).
     */
    fun checkIdentity(userId: String, keyVersion: ULong) {
        if (keyVersion < seen(identityKey(userId))) throw IdentityRolledBack()
    }

    /* Raised only once the identity opened under the account key, which binds its key version: a forged one can't lift it. */
    fun recordIdentity(userId: String, keyVersion: ULong) = record(identityKey(userId), keyVersion)

    companion object {
        private val LOCK = Any()

        /* In noBackupFilesDir: device-local by definition, and not one of the account's files a sign-out removes. */
        fun of(context: Context) = SettingsMark(File(context.noBackupFilesDir, "settings-seen.json"))

        /* The account's settings mark: per user, whatever identity it holds now. */
        fun key(userId: String): String = keyDigest("settings\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))

        /* The newest version 2 settings this device opened or saved: once there is one, none at all is a rollback. */
        fun v2Key(userId: String): String = keyDigest("settings-v2\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))

        /* The highest own identity key version this device opened for the account. */
        fun identityKey(userId: String): String = keyDigest("identity\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))

        /* How an earlier app named the settings mark: per account and identity. Read once, to carry it over. */
        fun legacyKey(userId: String, encryptionPublicKey: String): String = keyDigest("${userId.lowercase()}\n$encryptionPublicKey".toByteArray(Charsets.UTF_8))
    }
}
