package com.hushos.app.data

import android.content.Context
import com.hushos.core.GuardEntry
import com.hushos.core.PinKeys
import com.hushos.core.SettingsKeyEnvelope
import com.hushos.core.contactGuardOpen
import com.hushos.core.contactGuardSeal
import com.hushos.core.contactGuardSlot
import com.hushos.core.keyCommitment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/*
 * The contact guard (docs/optional-verification.md 2.8; the web's lib/contact-guard.ts, iOS's ContactGuard.swift): what
 * this phone keeps, per account and per person, of the keys it last acted on, apart from the settings document. A newer
 * copy of the settings that drops or swaps a pin (an older copy saved over at a higher sequence, or an empty one) is met
 * here as a change, never as first use, since nothing in the settings can stand in for what this phone saw. Never
 * written to the settings and never cleared by anything the server answers.
 *
 * One record per account (the same user id on another server is another account) in `noBackupFilesDir/guard/<slot>.json`,
 * the slot the core's `contact_guard_slot` (a digest of the server and the user id, found without a key), so the file
 * name says neither whose it is nor whom it is about. Sealed by the core (`contact_guard_seal`) under a key from the
 * settings key, as the rollback marks are, with the settings key's envelope as the server keeps it beside the record,
 * so it opens without asking the server (`keys`, the marks' own path). A record that is there and does not open (no
 * account key, another settings key, damaged or swapped bytes) is unreadable, never "nothing recorded". Out of backups
 * (noBackupFilesDir, `allowBackup="false"`), deleted on every wipe with the rest of the account (AccountStore).
 *
 * The app and the DocumentsProvider run in one process, so one process-wide lock serialises every write: one
 * read-change-write, only while the session it was read for is still stored and no sign-out came since; sign-out
 * deletes the records under the same lock. A commit lands only over the revision it read (GuardRaced otherwise), so a
 * delayed write never puts an older entry back. A write that can't be kept is GuardUnsaved.
 */
object GuardWords {
    const val UNREADABLE = "HushOS couldn’t check this right now."
    const val UNSAVED = "HushOS couldn’t save this on this device. Free up some space, then try again."
    /* Another writer moved an entry between an act's read and its write (the web's TrustMovedError words). */
    const val MOVED = "Your contacts changed on another device. Try again."
}

class GuardUnreadable : Refused("Nothing was changed", GuardWords.UNREADABLE)

class GuardUnsaved : Refused("Nothing was changed", GuardWords.UNSAVED)

class GuardRaced : Refused("Nothing was changed", GuardWords.MOVED)

/*
 * A trust-changing act on its way: the key commitment it moves to, from `revision`, and `base`, the stored settings
 * sequence its save was sent over (the server's compare-and-set lands it only while that is still stored).
 */
data class PendingAct(val target: String, val revision: ULong, val at: String, val base: ULong?) {
    fun json(): JSONObject = JSONObject().put("target", target).put("revision", revision.toLong()).put("at", at).put("base", base?.toLong() ?: JSONObject.NULL)

    companion object {
        fun from(json: JSONObject) = PendingAct(json.getString("target"), json.getLong("revision").toULong(), json.optString("at"),
            if (json.isNull("base")) null else json.getLong("base").toULong())
    }
}

/* A guard entry's keys as a pin's: what its key commitment is worked out over. */
val GuardEntry.keys: PinKeys get() = PinKeys(keyVersion, encryptionPublicKey, signingPublicKey, mlDsaPublicKeyHash, kemPublicKeyHash, "")

internal fun GuardEntry.json(): JSONObject = JSONObject().put("revision", revision.toLong()).put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL)
    .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey).put("mlDsaPublicKeyHash", mlDsaPublicKeyHash)
    .put("kemPublicKeyHash", kemPublicKeyHash).put("previousSigningKeys", JSONArray(previousSigningKeys)).put("verified", verified)

/* The entry, or null when it is not one the guard could have written: read as unreadable. */
internal fun guardEntryOf(json: JSONObject): GuardEntry? = runCatching {
    val previous = json.getJSONArray("previousSigningKeys").let { a -> (0 until a.length()).map { a.getString(it) } }
    val entry = GuardEntry(json.getLong("revision").toULong(), if (json.isNull("keyVersion")) null else json.getLong("keyVersion").toULong(),
        json.getString("encryptionPublicKey"), json.getString("signingPublicKey"), json.getString("mlDsaPublicKeyHash"),
        json.getString("kemPublicKeyHash"), previous, json.getBoolean("verified"))
    // Keys that make no commitment would match nothing: a damaged entry, never one to judge by.
    entry.takeIf { it.revision >= 1uL && previous.none(String::isEmpty) && keyCommitment(it.keys) != null }
}.getOrNull()

/* The settings key the guard is sealed under, given the envelope kept beside it (null for none kept); null when none can be had. */
typealias GuardKeys = (kept: SettingsKeyEnvelope?) -> MarksKey?

class ContactGuard(
    private val folder: File, private val origin: String, private val userId: String, private val keys: GuardKeys,
    /* Whether the session this guard is kept for is still the one stored (see SettingsMark.signedIn). */
    private val signedIn: () -> Boolean = { true },
) {
    /* One account's guard: its entries and acts left pending, by lowercased contact id. */
    class Record(val entries: MutableMap<String, GuardEntry> = LinkedHashMap(), val pending: MutableMap<String, PendingAct> = LinkedHashMap())

    private class Sealed(val key: SettingsKeyEnvelope, val record: String)

    val slot: String get() = contactGuardSlot(origin, userId)

    val file: File get() = File(folder, "$slot.json")

    /* What is on disk: null when nothing is; GuardUnreadable when something is that isn't a sealed guard. */
    private fun sealed(): Sealed? {
        val file = file
        if (!file.exists()) return null
        return runCatching {
            val json = JSONObject(file.readText())
            check(json.getInt("v") == 2)
            val key = json.getJSONObject("key")
            Sealed(SettingsKeyEnvelope(key.getString("nonce"), key.getString("ciphertext")), json.getString("record"))
        }.getOrElse { throw GuardUnreadable() }
    }

    /*
     * The record: empty when there is none; GuardUnreadable when one is there and doesn't open under the key it was
     * sealed beside or the account's (or none can be had), or holds an entry that isn't one.
     */
    fun record(): Record {
        val sealed = sealed() ?: return Record()
        val key = runCatching { keys(sealed.key) }.getOrNull() ?: throw GuardUnreadable()
        return open(sealed, key)
    }

    private fun open(sealed: Sealed, key: MarksKey): Record = runCatching {
        val json = JSONObject(contactGuardOpen(key.key, userId, slot, KIND, sealed.record))
        check(json.getInt("v") == 1)
        val record = Record()
        json.getJSONObject("entries").let { all -> for (id in all.keys()) record.entries[id] = guardEntryOf(all.getJSONObject(id)) ?: error("entry") }
        json.getJSONObject("pending").let { all -> for (id in all.keys()) record.pending[id] = PendingAct.from(all.getJSONObject(id)) }
        record
    }.getOrElse { throw GuardUnreadable() }

    fun entry(contactId: String): GuardEntry? = record().entries[contactId.lowercase()]

    fun pending(contactId: String): PendingAct? = record().pending[contactId.lowercase()]

    /* Writes `act` for the person, durably, before the settings save it names. */
    fun putPending(contactId: String, act: PendingAct) = change { it.pending[contactId.lowercase()] = act }

    /*
     * Writes `entry` and deletes the pending record in one write, only over `revision` (0 for none stored): a write that
     * read an earlier revision than is stored throws GuardRaced and changes nothing. `keep`, an act whose save may still
     * land: kept instead, moved to the new revision.
     */
    fun commit(contactId: String, entry: GuardEntry, over: ULong, keep: PendingAct? = null) {
        val id = contactId.lowercase()
        change { record ->
            if ((record.entries[id]?.revision ?: 0uL) != over) throw GuardRaced()
            record.entries[id] = entry
            if (keep != null) record.pending[id] = keep.copy(revision = entry.revision) else record.pending.remove(id)
        }
    }

    fun dropPending(contactId: String) = change { it.pending.remove(contactId.lowercase()) }

    /*
     * One read-change-write under the process lock. A record that doesn't read is never written over; a sign-out since
     * the write began, or a session no longer stored, writes nothing.
     */
    private fun change(body: (Record) -> Unit) {
        val began = synchronized(LOCK) { GENERATION }
        if (!signedIn()) throw GuardUnsaved()
        synchronized(LOCK) {
            if (!signedIn() || GENERATION != began) throw GuardUnsaved()
            val held = sealed()
            val key = runCatching { keys(held?.key) }.getOrNull() ?: throw if (held != null) GuardUnreadable() else GuardUnsaved()
            val record = if (held == null) Record() else open(held, key)
            body(record)
            try {
                folder.mkdirs()
                val json = JSONObject().put("v", 1)
                    .put("entries", JSONObject().also { all -> record.entries.forEach { (id, entry) -> all.put(id, entry.json()) } })
                    .put("pending", JSONObject().also { all -> record.pending.forEach { (id, act) -> all.put(id, act.json()) } })
                val envelope = contactGuardSeal(key.key, userId, slot, KIND, json.toString())
                val out = JSONObject().put("v", 2).put("key", JSONObject().put("nonce", key.envelope.nonce).put("ciphertext", key.envelope.ciphertext))
                    .put("record", envelope)
                // Written beside and moved over, so a crash mid-write never leaves half a record.
                val next = File(file.path + ".next")
                next.writeText(out.toString())
                if (!next.renameTo(file)) throw java.io.IOException("not moved")
            } catch (_: Exception) {
                throw GuardUnsaved()
            }
        }
    }

    companion object {
        private val LOCK = Any()
        /* Moved by every sign-out: a write begun before it keeps nothing. */
        private var GENERATION = 0L
        private const val KIND = "record"

        /* Under noBackupFilesDir. */
        const val FOLDER = "guard"

        /* The guard kept for the vault signed in with `session`. */
        fun of(context: Context, session: Shared.Session, keys: GuardKeys) =
            ContactGuard(File(context.noBackupFilesDir, FOLDER), session.origin, session.userId, keys) { Shared.session(context)?.token == session.token }

        /* Sign-out: every account's guard on this phone, under the lock, so a write holding it finishes first and is deleted. */
        fun deleteAll(noBackup: File) {
            synchronized(LOCK) {
                GENERATION++
                File(noBackup, FOLDER).deleteRecursively()
            }
        }
    }
}

/*
 * The account's trust-changing acts and the reads that judge from the guard, one at a time in this process (the web's
 * Web Lock): a Continue never interleaves with an add for one person, whichever Vault (the app's, the provider's) runs it.
 */
object GuardTurn {
    private val lock = java.util.concurrent.locks.ReentrantLock()

    fun <T> run(body: () -> T): T {
        lock.lock()
        try {
            return body()
        } finally {
            lock.unlock()
        }
    }
}
