package com.hushos.app.data

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/*
 * Another app's saves of one file through the Files app, coalesced: each file has at most one pending slot, the newest
 * save's whole contents (`content`) and a small record (`record.json`: its generation and what the upload needs), in the
 * transfer queue's folder (queue/<slot>, so cancel, dismiss, a family's end and every account wipe take it with the
 * rest of the queue). A save replaces the slot's contents and then its record, each with one rename, under the slot's
 * lock and only while the account that made it is still the one on the phone; it never makes a second upload. One job
 * per slot (TransferQueue.enqueueSlot) sends whatever the slot holds when it runs, and clears the slot only when the
 * slot still holds the generation it sent; a newer save that arrived meanwhile is sent next. So only the newest contents
 * are ever sent, an older one can never land after a newer one, and the newest always gets its chance: a failed send
 * keeps the slot for Retry, and a cancel or a dismiss drops it.
 *
 * Every open of the file (to read, or to write keeping the contents) starts from the slot while there is one, so what
 * another app reads is what it last saved, whether its upload is waiting, retrying, failed or its job long pruned. Ids
 * and paths only, beside the record's name and type (the queue's other copies keep the same).
 */
object WriteBacks {
    const val SLOT = "slot:"
    private const val CONTENT = "content"
    private const val RECORD = "record.json"

    /* A file's slot: its workspace and node, both ids; also its folder's name and its job's unique name. */
    fun slotOf(workspaceId: String, nodeId: String): String = "writeback-${workspaceId.lowercase()}-${nodeId.lowercase()}"

    /* What a slot's upload needs: the file, as it was when the app opened it (the job looks it up again), and its family. */
    data class Target(
        val workspaceId: String, val nodeId: String, val name: String, val mime: String?, val folder: String,
        val family: String? = null, val familyWorkspace: String? = null,
    )

    /*
     * A save: its generation (counts up while the slot holds saves, to tell newer from older) and its id, never reused,
     * not even after the slot empties and counts from one again (its upload's ledger key, and what landing compares).
     */
    data class Pending(val slot: String, val generation: Long, val id: String, val target: Target) {
        /* The upload ledger's key for this save: its landed row, if an answer was lost, belongs to this save alone. */
        val ledger get() = "$slot#$id"
    }

    /* The ledger keys of every save `slot` has had: its landed rows, superseded saves' included, go when it empties. */
    fun ledgerOf(slot: String, job: String) = job.startsWith("$slot#")

    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    private fun lockOf(slot: String) = locks.getOrPut(slot) { ReentrantLock() }

    fun dir(context: Context, slot: String) = File(context.filesDir, "queue/$slot")

    /* Where the slot's contents are: what a failed row and the panel name as the job's copy. */
    fun contentOf(context: Context, slot: String) = File(dir(context, slot), CONTENT)

    private fun readRecord(dir: File, slot: String): Pending? = runCatching {
        val json = JSONObject(File(dir, RECORD).readText())
        if (!File(dir, CONTENT).exists()) return null
        Pending(slot, json.getLong("generation"), json.getString("id"), Target(
            json.getString("workspaceId"), json.getString("nodeId"), json.getString("name"), json.opt("mime") as? String, json.getString("folder"),
            json.opt("family") as? String, json.opt("familyWorkspace") as? String,
        ))
    }.getOrNull()

    /* The slot's pending save, if it has one (contents and record both there). */
    fun pending(context: Context, slot: String): Pending? = lockOf(slot).withLock { readRecord(dir(context, slot), slot) }

    /* Tests: runs right after a save's contents are in place, before its record is. */
    @Volatile internal var afterContent: (() -> Unit)? = null

    /*
     * `edit`'s bytes become the slot's newest save: its contents renamed into place, then its record (written beside and
     * renamed), under the slot's lock and only while the account `accountGeneration` names is still the one on the phone
     * (Reservations.whileAccount: an account wipe moves it, so a save racing a sign-out writes nothing back). The slot is
     * never without contents in between: the old ones are replaced by a rename. Null when the account left.
     */
    fun save(context: Context, accountGeneration: Long, target: Target, edit: File): Pending? = Reservations.whileAccount(accountGeneration) {
        val slot = slotOf(target.workspaceId, target.nodeId)
        lockOf(slot).withLock {
            val dir = dir(context, slot).also { it.mkdirs() }
            val generation = (readRecord(dir, slot)?.generation ?: 0L) + 1
            val incoming = File(dir, "$CONTENT.incoming")
            if (!edit.renameTo(incoming)) edit.copyTo(incoming, overwrite = true)
            check(incoming.renameTo(File(dir, CONTENT))) { "The save couldn't be kept." }
            afterContent?.invoke()
            val id = java.util.UUID.randomUUID().toString()
            val record = JSONObject().put("generation", generation).put("id", id).put("workspaceId", target.workspaceId).put("nodeId", target.nodeId)
                .put("name", target.name).put("mime", target.mime ?: JSONObject.NULL).put("folder", target.folder)
                .put("family", target.family ?: JSONObject.NULL).put("familyWorkspace", target.familyWorkspace ?: JSONObject.NULL)
            val written = File(dir, "$RECORD.incoming").apply { writeText(record.toString()) }
            check(written.renameTo(File(dir, RECORD))) { "The save couldn't be kept." }
            Pending(slot, generation, id, target)
        }
    }

    /* A copy of the slot's newest save in `dest` (an open starts from it); false when there is none. */
    fun copyTo(context: Context, slot: String, dest: File): Boolean = lockOf(slot).withLock {
        if (readRecord(dir(context, slot), slot) == null) return false
        dest.parentFile?.mkdirs()
        contentOf(context, slot).copyTo(dest, overwrite = true)
        true
    }

    /*
     * The newest save to send: its record and a copy of its contents of its own (sending-<id>), so a newer save
     * replacing the slot's contents meanwhile never changes the bytes under the upload. Null when the slot is empty.
     */
    fun take(context: Context, slot: String): Pair<Pending, File>? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val pending = readRecord(dir, slot) ?: return null
        val sending = File(dir, "sending-${pending.id}")
        File(dir, CONTENT).copyTo(sending, overwrite = true)
        pending to sending
    }

    /* The slot's saves dropped (cancelled): under its lock, so a save landing in it meanwhile is either kept whole or gone. */
    fun drop(context: Context, slot: String) = lockOf(slot).withLock { dir(context, slot).deleteRecursively() }

    /*
     * The save `id` landed: the slot is cleared only while it still holds that save (a newer save stays to be sent next),
     * by id, so a save made after the slot emptied (its generation counting from one again) is never taken for it. Under
     * the slot's lock, inside the account's (the caller's forItsAccount). True when the slot is now empty.
     */
    fun landed(context: Context, slot: String, id: String): Boolean = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val held = readRecord(dir, slot)
        if (held == null || held.id == id) { dir.deleteRecursively(); true } else {
            dir.listFiles()?.filter { it.name.startsWith("sending-") }?.forEach { it.delete() }
            false
        }
    }
}
