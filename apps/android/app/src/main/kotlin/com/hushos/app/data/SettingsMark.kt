package com.hushos.app.data

import android.content.Context
import com.hushos.core.CoreException
import com.hushos.core.RollbackMarks
import com.hushos.core.SettingsKeyEnvelope
import com.hushos.core.keyDigest
import com.hushos.core.rollbackMarksSlot
import com.hushos.core.rollbackMarksUpdate
import org.json.JSONObject
import java.io.File

class SettingsRolledBack : Refused("Nothing was changed", "The server sent older settings than this device has seen. Nothing was changed.")

class IdentityRolledBack : Refused("Nothing was changed", "The server sent older sharing keys than this device has used. Nothing was changed.")

/* The marks are there and do not open: never "nothing seen". */
class MarksUnreadable : Refused("Nothing was opened", "HushOS couldn’t read what this phone last saw of your account, so nothing was opened. Sign out and sign in again to start this phone afresh.")

/* A mark could not be kept: what it guards is not taken, since a later visit could not tell an older copy from it. */
class MarksUnsaved : Refused("Nothing was opened", "HushOS couldn’t record what this phone has seen of your account, so nothing was opened. Try again.")

/* The settings key the marks are sealed under, and its envelope as the server keeps it. */
class MarksKey(val key: ByteArray, val envelope: SettingsKeyEnvelope)

/*
 * The settings key for the marks: the kept envelope's when it opens under the account key, else the server's; made only
 * with `create` (a raise with nothing kept). Null when the account has none and none may be made. Throws when it could
 * not ask.
 */
typealias MarksKeys = (kept: SettingsKeyEnvelope?, create: Boolean) -> MarksKey?

private val NONE = RollbackMarks(0uL, false, 0uL, 0uL)

private fun RollbackMarks.highest(other: RollbackMarks) = RollbackMarks(
    maxOf(settings, other.settings), settingsDocument || other.settingsDocument,
    maxOf(identity, other.identity), maxOf(identityVersion, other.identityVersion),
)

/*
 * Rollback marks (docs/integrity-design.md, "Rollback marks"; the web's lib/rollback-marks.ts): the newest settings
 * sequence seen, whether a version 2 settings document was, and the highest own identity key version and identity
 * version opened, per account. The server keeps the settings and the identity and could hand back an older settings
 * document (a pin the person replaced, a ledger with a share they stopped) or none at all, or an identity the account
 * replaced. A mark only ever rises, and a succession does not reset it: the settings are the account's.
 *
 * Sealed, and the account's: one record per account in `noBackupFilesDir/marks/<slot>.json`, sealed by the core under a
 * key from the settings key (`rollbackMarksUpdate`), so what the phone keeps says neither whose marks they are nor what
 * they count without the account's keys. The slot is a digest of the user id, found without a key, so a record that is
 * there and does not open (damaged, swapped, or under another settings key) is refused (MarksUnreadable), never read as
 * none. Beside the marks sits the settings key's envelope as the server keeps it (wrapped under the account key), so
 * they open without asking the server. Sign-out, account deletion and a removal delete them with everything else of
 * the account (AccountStore): a phone signed back in trusts the server as a new device does.
 *
 * A mark that cannot be kept fails the step it guards (MarksUnsaved). What a raise asked for still counts in this
 * process at once, so a raise that could not be written refuses a rollback here all the same (an upgraded identity
 * served as version 1 again would mint a second ML-DSA key) and goes into the next write.
 *
 * Every write runs under one lock, and only while the session it began under is still stored; sign-out deletes the marks
 * under the same lock (`deleteAll`).
 *
 * Earlier versions kept the marks in the clear, by digest, in `noBackupFilesDir/settings-seen.json`, across sign-outs.
 * The account's entries are folded into the sealed record the first time it is read or raised, and then removed.
 */
/*
 * `signedIn` says whether the session these marks are kept for (the vault's) is still the one stored. A raise keeps a
 * mark only while it is: one still waiting for the settings key when the person signed out (or another account signed
 * in) must not write the marks back after the wipe, which deletes them under the same lock (`deleteAll`).
 */
class SettingsMark(private val folder: File, private val keys: MarksKeys, private val signedIn: () -> Boolean = { true }) {
    private val legacyFile = File(folder.parentFile, LEGACY_FILE)

    /* What a slot's file holds; null for none. Throws MarksUnreadable for a file that is there and doesn't parse. */
    private class Record(val marks: String, val key: SettingsKeyEnvelope?)

    private fun record(file: File): Record? {
        if (!file.exists()) return null
        return runCatching {
            val json = JSONObject(file.readText())
            val key = json.optJSONObject("key")?.let { SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext")) }
            Record(json.getString("marks"), key)
        }.getOrElse { throw MarksUnreadable() }
    }

    private fun file(user: String) = File(folder, "${rollbackMarksSlot(user)}.json")

    /* This phone's marks for the account, with this process's raises in; plaintext ones of earlier versions count and are sealed. */
    fun read(userId: String): RollbackMarks {
        val user = userId.lowercase()
        val earlier = legacy(user, emptyList())
        if (earlier.second.isNotEmpty()) {
            try {
                return raise(user, NONE)
            } catch (_: MarksUnsaved) {
                // Not sealed this time: the plaintext stays, and counts.
                return stored(user).highest(earlier.first).highest(floor(user))
            }
        }
        return stored(user).highest(floor(user))
    }

    private fun stored(user: String): RollbackMarks {
        val record = record(file(user)) ?: return NONE
        val key = try {
            keys(record.key, false)
        } catch (_: CoreException) {
            throw MarksUnreadable()
        } ?: throw MarksUnreadable()
        return try {
            rollbackMarksUpdate(key.key, user, record.marks, NONE).marks
        } catch (_: CoreException) {
            throw MarksUnreadable()
        }
    }

    /*
     * Raises the marks to at least `to` (with what this process raised before, and what an earlier version kept in the
     * clear, the per-identity settings marks under `encryptionPublicKeys` included), never lowering any. Throws
     * MarksUnsaved when they could not be kept and MarksUnreadable when the record does not open.
     */
    fun raise(userId: String, to: RollbackMarks, encryptionPublicKeys: List<String> = emptyList()): RollbackMarks {
        val user = userId.lowercase()
        // What this process raises counts only until the next sign-out: a raise from before it keeps nothing.
        val generation = synchronized(LOCK) { GENERATION }
        if (!signedIn() || !raiseFloor(user, to, generation)) throw MarksUnsaved()
        val (earlierMarks, earlierKeys) = legacy(user, encryptionPublicKeys)
        val wanted = to.highest(floor(user)).highest(earlierMarks)
        val url = file(user)
        val kept = record(url)
        // Nothing to keep and nothing kept: no record, and no settings key made for one.
        if (kept == null && wanted == NONE && earlierKeys.isEmpty()) return NONE
        val key = try {
            keys(kept?.key, kept == null)
        } catch (_: Exception) {
            throw MarksUnsaved()
        } ?: throw if (kept == null) MarksUnsaved() else MarksUnreadable()
        val marks = synchronized(LOCK) {
            // Signed out (or someone else signed in) while this waited: the wipe has run, or waits for this lock.
            if (!signedIn()) throw MarksUnsaved()
            // Read again under the lock: what another thread wrote meanwhile is opened and kept.
            val current = record(url)
            val update = try {
                rollbackMarksUpdate(key.key, user, current?.marks, wanted)
            } catch (_: CoreException) {
                throw MarksUnreadable()
            }
            if (current == null || update.changed || current.key != key.envelope) {
                try {
                    folder.mkdirs()
                    val json = JSONObject().put("marks", update.envelope)
                        .put("key", JSONObject().put("nonce", key.envelope.nonce).put("ciphertext", key.envelope.ciphertext))
                    // Written beside and moved over, so a crash mid-write never leaves half a record.
                    val next = File(url.path + ".next")
                    next.writeText(json.toString())
                    if (!next.renameTo(url)) { url.writeText(json.toString()); next.delete() }
                } catch (_: Exception) {
                    throw MarksUnsaved()
                }
            }
            forgetLegacy(earlierKeys, update.marks, user)
            update.marks
        }
        // Signed out right after the write: the wipe deleted it, and nothing of it stays here either.
        if (!raiseFloor(user, marks, generation)) throw MarksUnsaved()
        return marks
    }

    /* Folds in the per-identity settings marks an earlier version kept under these keys, if any. */
    fun adopt(userId: String, encryptionPublicKeys: List<String>) {
        val user = userId.lowercase()
        if (legacy(user, encryptionPublicKeys).second.isNotEmpty()) raise(user, NONE, encryptionPublicKeys)
    }

    /*
     * The settings the server serves now, against this account's marks. `sequence` is the stored settings sequence,
     * which the server serves with or without a document: below the newest this device has seen is a rollback,
     * document or not. No document at a sequence at or above the mark is a version 1 row (served as none, since no
     * client opens those any more), unless this device has seen a version 2 document: those are never served as none.
     */
    fun checkSettings(userId: String, sequence: ULong, present: Boolean) {
        val seen = read(userId)
        if (sequence < seen.settings) throw SettingsRolledBack()
        if (!present && seen.settingsDocument) throw SettingsRolledBack()
    }

    /* Raises the account's settings mark; `sealedV2` also raises the mark that makes "none" a rollback. */
    fun recordSettings(userId: String, version: ULong, sealedV2: Boolean) {
        raise(userId, RollbackMarks(version, sealedV2, 0uL, 0uL))
    }

    /*
     * An own identity served as current, once opened: refused when its key version is lower than one this device
     * already opened (an identity the account replaced, served again), or when it is the version 1 form once this
     * device has seen version 2, at any key version. The upgrade keeps the key version, so the key version alone does
     * not see that rollback, and opening the version 1 form would mint a second ML-DSA key (docs/identity-pq-design.md 2).
     */
    fun checkIdentity(userId: String, keyVersion: ULong, identityVersion: UInt) {
        val seen = read(userId)
        if (keyVersion < seen.identity) throw IdentityRolledBack()
        // Once version 2 has been seen, the version 1 form is a rollback at any key version: every
        // identity made since the post-quantum release is version 2 (docs/identity-pq-design.md 2).
        if (identityVersion.toULong() < seen.identityVersion) throw IdentityRolledBack()
    }

    /* Raised only once the identity opened under the account key, which binds its key version: a forged one can't lift it. */
    fun recordIdentity(userId: String, keyVersion: ULong, identityVersion: UInt) {
        raise(userId, RollbackMarks(0uL, false, keyVersion, identityVersion.toULong()))
    }

    /* What the plaintext file holds for the account: the highest of each mark, and the entries it came from. */
    private fun legacy(user: String, encryptionPublicKeys: List<String>): Pair<RollbackMarks, List<String>> {
        if (!legacyFile.exists()) return NONE to emptyList()
        val json = runCatching { JSONObject(legacyFile.readText()) }.getOrNull() ?: return NONE to emptyList()
        val settings = listOf(legacyKey(user)) + encryptionPublicKeys.map { legacyKey(user, it) }
        var marks = NONE
        val names = ArrayList<String>()
        for (name in json.keys()) {
            val value = json.optLong(name, 0L).coerceAtLeast(0L).toULong()
            val mark = when (name) {
                in settings -> RollbackMarks(value, false, 0uL, 0uL)
                legacyV2Key(user) -> RollbackMarks(0uL, value > 0uL, 0uL, 0uL)
                legacyIdentityKey(user) -> RollbackMarks(0uL, false, value, 0uL)
                legacyIdentityVersionKey(user) -> RollbackMarks(0uL, false, 0uL, value)
                else -> continue
            }
            marks = marks.highest(mark)
            names.add(name)
        }
        return marks to names
    }

    /* Each plaintext entry the sealed record now holds goes; a file left empty goes whole. */
    private fun forgetLegacy(names: List<String>, sealed: RollbackMarks, user: String) {
        if (names.isEmpty()) return
        val json = runCatching { JSONObject(legacyFile.readText()) }.getOrNull() ?: return
        for (name in names) {
            val value = json.optLong(name, 0L).coerceAtLeast(0L).toULong()
            val held = when (name) {
                legacyV2Key(user) -> value == 0uL || sealed.settingsDocument
                legacyIdentityKey(user) -> value <= sealed.identity
                legacyIdentityVersionKey(user) -> value <= sealed.identityVersion
                else -> value <= sealed.settings
            }
            if (held) json.remove(name)
        }
        runCatching { if (json.length() == 0) legacyFile.delete() else legacyFile.writeText(json.toString()) }
    }

    private fun floor(user: String) = synchronized(LOCK) { FLOOR["${folder.path}\n$user"] ?: NONE }

    /* Raises what this process counts for `user`, unless a sign-out came since `generation`; whether it did. */
    private fun raiseFloor(user: String, marks: RollbackMarks, generation: Long): Boolean = synchronized(LOCK) {
        if (GENERATION != generation) return false
        FLOOR["${folder.path}\n$user"] = (FLOOR["${folder.path}\n$user"] ?: NONE).highest(marks)
        true
    }

    companion object {
        private val LOCK = Any()
        /* What this process raised, per folder and account, whether or not it reached the file. */
        private val FLOOR = HashMap<String, RollbackMarks>()
        /* Moved by every sign-out: a raise begun before it keeps nothing. */
        private var GENERATION = 0L

        /* Under noBackupFilesDir: the sealed records, and the plaintext file earlier versions kept. */
        const val FOLDER = "marks"
        const val LEGACY_FILE = "settings-seen.json"

        /* The marks kept for the vault signed in with `token`. */
        fun of(context: Context, token: String, keys: MarksKeys) =
            SettingsMark(File(context.noBackupFilesDir, FOLDER), keys) { Shared.session(context)?.token == token }

        /*
         * Sign-out: the records under `noBackup`, the plaintext file of earlier versions, and what this process raised.
         * Under the lock, so a raise already writing finishes first (and is deleted), and one after finds its session gone.
         */
        fun deleteAll(noBackup: File) {
            synchronized(LOCK) {
                FLOOR.clear()
                GENERATION++
                File(noBackup, FOLDER).deleteRecursively()
                File(noBackup, LEGACY_FILE).delete()
            }
        }

        /* What this process raised (tests: a fresh process). */
        fun forgetRaised() {
            synchronized(LOCK) {
                FLOOR.clear()
                GENERATION++
            }
        }

        /* How earlier versions named the marks in the clear: digests, per account, and per identity before that. */
        fun legacyKey(userId: String): String = keyDigest("settings\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))
        fun legacyV2Key(userId: String): String = keyDigest("settings-v2\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))
        fun legacyIdentityKey(userId: String): String = keyDigest("identity\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))
        fun legacyIdentityVersionKey(userId: String): String = keyDigest("identity-version\n${userId.lowercase()}".toByteArray(Charsets.UTF_8))
        fun legacyKey(userId: String, encryptionPublicKey: String): String = keyDigest("${userId.lowercase()}\n$encryptionPublicKey".toByteArray(Charsets.UTF_8))
    }
}
