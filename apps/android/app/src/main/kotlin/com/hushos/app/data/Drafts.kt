package com.hushos.app.data

import android.content.Context
import com.hushos.core.Draft
import com.hushos.core.DraftEntry
import com.hushos.core.DraftOffer
import com.hushos.core.draftLimits
import com.hushos.core.draftOffer
import com.hushos.core.draftOpen
import com.hushos.core.draftSavedAt
import com.hushos.core.draftSeal
import com.hushos.core.draftSlot
import com.hushos.core.draftsToDrop
import java.io.File
import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/*
 * Drafts on the phone (docs/editing-design.md 3, "Draft"; Editing 1c; the web's lib/drafts.ts, iOS's Drafts.swift): the text
 * editor's unsaved text, sealed by the core under a key derived from the account key for this account and file (drafts.rs:
 * HKDF of the root, info ["hushos/drafts/v1",user,workspace,node]; XChaCha20-Poly1305 with the base version, the session's
 * save format and the time bound in), one record per file in `noBackupFilesDir/drafts`, found by a slot only the unlocked
 * account works out. Out of backups, deleted with everything else of the account on sign-out, deletion and another
 * account's sign-in (AccountStore.wipe), and never sent anywhere.
 *
 * Bounds (the core's draft_limits): 8 MiB of text per draft, 50 drafts (the phone holds one account's data at a time:
 * another account's sign-in wipes it), 30 days. A store that fails never stops editing: the write says so.
 */
data class DraftPlace(val userId: String, val workspaceId: String, val nodeId: String) {
    companion object {
        fun of(userId: String, file: Opened) = DraftPlace(userId.lowercase(), file.node.workspaceId.lowercase(), file.id.lowercase())
    }
}

class DraftStore(private val folder: File, private val now: () -> Long = System::currentTimeMillis) {
    // Base64url: letters, digits, '-' and '_' only, so a file name as it is.
    private fun file(slot: String) = File(folder, "$slot.json")

    private fun slot(place: DraftPlace, key: ByteArray) = draftSlot(key, place.userId, place.workspaceId, place.nodeId)

    /*
     * Seals and keeps `draft` for `place`, keeping the caps; false when it couldn't be kept (past the limit, half a character
     * in the text, a full disk). The last draft kept stays then.
     */
    /* What a write asked for now carries: a wipe (a sign-out) after it moves this, and the write keeps nothing. */
    val generation: Long get() = synchronized(LOCK) { MOVED[folder.absolutePath] ?: 0L }

    fun write(draft: Draft, place: DraftPlace, key: ByteArray, asked: Long = generation): Boolean = synchronized(LOCK) {
        writeLocked(draft, place, key, asked)
    }

    /* Under LOCK: a write asked for before a wipe (a sign-out) writes nothing after it. */
    private fun writeLocked(draft: Draft, place: DraftPlace, key: ByteArray, asked: Long): Boolean = runCatching {
        if (asked != (MOVED[folder.absolutePath] ?: 0L) || !TextEditing.writable(draft.text)) return false
        val slot = slot(place, key)
        val record = draftSeal(key, place.userId, place.workspaceId, place.nodeId, draft)
        folder.mkdirs()
        val entries = (folder.listFiles() ?: emptyArray()).filter { it.name.endsWith(".json") }.map {
            DraftEntry(it.name.removeSuffix(".json"), runCatching { draftSavedAt(it.readText()) }.getOrNull())
        }
        for (gone in draftsToDrop(entries, now().toULong(), slot)) file(gone).delete()
        // Written beside it, then moved into place: a kill mid-write never leaves half a record.
        val partial = File(folder, "$slot.json.partial")
        partial.writeText(record)
        if (!partial.renameTo(file(slot))) {
            partial.delete()
            return false
        }
        true
    }.getOrDefault(false)

    /* The file's draft, or null: none, or one that doesn't open here or is too old, which is deleted (nothing can show it). */
    fun read(place: DraftPlace, key: ByteArray): Draft? = synchronized(LOCK) { readLocked(place, key) }

    private fun readLocked(place: DraftPlace, key: ByteArray): Draft? {
        val slot = runCatching { slot(place, key) }.getOrNull() ?: return null
        val record = file(slot).takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() } ?: return null
        val draft = runCatching { draftOpen(key, place.userId, place.workspaceId, place.nodeId, record) }.getOrNull()
        if (draft == null || now().toULong() > draft.frame.savedAt + draftLimits().maxAgeMs) {
            file(slot).delete()
            return null
        }
        return draft
    }

    fun remove(place: DraftPlace, key: ByteArray) {
        synchronized(LOCK) { runCatching { file(slot(place, key)).delete() } }
    }

    /* How many drafts are kept. */
    val count: Int get() = (folder.listFiles() ?: emptyArray()).count { it.name.endsWith(".json") }

    companion object {
        const val DIR = "drafts"
        private val LOCK = Any()
        /* Moved by every wipe of a folder, under LOCK. */
        private val MOVED = HashMap<String, Long>()

        fun of(context: Context) = DraftStore(File(context.noBackupFilesDir, DIR))

        /* Sign-out, deletion, removal, another account's sign-in (AccountStore.wipe): under LOCK, so no write lands after. */
        fun deleteAll(noBackup: File) = synchronized(LOCK) {
            val folder = File(noBackup, DIR)
            MOVED[folder.absolutePath] = (MOVED[folder.absolutePath] ?: 0L) + 1
            folder.deleteRecursively()
        }
    }
}

/* The editor's rules for drafts, apart from the screen so they can be held to tests (DraftsTest). */
object DraftRules {
    /* About two seconds after a change, and no more often while typing. */
    const val WRITE_DELAY_MS = 2_000L

    enum class Step { NONE, REMOVE, WRITE }

    /*
     * What a write turn does: nothing for read-only text, an unanswered offer or no version to start from; the draft goes once
     * the text is back at what was last opened or saved; otherwise it is written.
     */
    fun step(editable: Boolean, offering: Boolean, startedFrom: String?, atBaseline: Boolean): Step = when {
        !editable || offering || startedFrom == null -> Step.NONE
        atBaseline -> Step.REMOVE
        else -> Step.WRITE
    }

    /* What reopening does with the draft (the core's draft_offer, held to the web by fixtures/drafts.json). */
    fun offer(draft: Draft, openedVersionId: String?, openedText: String): DraftOffer =
        draftOffer(draft.frame.baseVersionId, draft.text, openedVersionId, openedText)

    /* "2:14 PM" today, "Nov 19, 2:14 PM" on another day, in the person's locale. */
    fun whenSaved(savedAt: Long, now: Long = System.currentTimeMillis(), locale: Locale = Locale.getDefault(),
                  zone: TimeZone = TimeZone.getDefault()): String {
        val time = DateFormat.getTimeInstance(DateFormat.SHORT, locale).apply { timeZone = zone }
        val at = Calendar.getInstance(zone, locale).apply { timeInMillis = savedAt }
        val today = Calendar.getInstance(zone, locale).apply { timeInMillis = now }
        val clock = time.format(Date(savedAt))
        if (at.get(Calendar.YEAR) == today.get(Calendar.YEAR) && at.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)) return clock
        val skeleton = if (at.get(Calendar.YEAR) == today.get(Calendar.YEAR)) "MMMd" else "yMMMd"
        val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton)
        val date = java.text.SimpleDateFormat(pattern, locale).apply { timeZone = zone }.format(Date(savedAt))
        return "$date, $clock"
    }
}

/* Where this account keeps `file`'s draft. */
fun Vault.draftPlace(file: Opened) = DraftPlace.of(api.session.userId, file)

/* Kept for `file`, on this phone only; false when it couldn't be. */
fun Vault.writeDraft(store: DraftStore, draft: Draft, file: Opened, asked: Long = store.generation): Boolean =
    runCatching { store.write(draft, draftPlace(file), unlockAccount(), asked) }.getOrDefault(false)

fun Vault.readDraft(store: DraftStore, file: Opened): Draft? =
    runCatching { store.read(draftPlace(file), unlockAccount()) }.getOrNull()

fun Vault.removeDraft(store: DraftStore, file: Opened) {
    runCatching { store.remove(draftPlace(file), unlockAccount()) }
}
