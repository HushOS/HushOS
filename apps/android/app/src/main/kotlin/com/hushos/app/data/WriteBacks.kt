package com.hushos.app.data

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/*
 * Another app's saves of one file through the Files app, coalesced: each file has at most one pending slot, in the
 * transfer queue's folder (queue/<slot>, so cancel, a family's end and every account wipe take it with the rest of the
 * queue). Each save is a generation of its own: its contents (`<id>.bin`) and its description (`<id>.json`: its
 * generation, its id and what the upload needs), both written whole and never changed. The slot's pending save is the
 * one `record.json` names, published by one rename after both are in place, so a save's contents and its identity change
 * together or not at all: a death before the rename leaves the earlier save pending with its own bytes, and the next
 * look under the lock publishes the newer complete generation it finds (`current`). Generations nothing names any more
 * go, only under the slot's lock.
 *
 * A save happens under the slot's lock and only while the account that made it is still the one on the phone; it never
 * makes a second upload. One job per slot (TransferQueue.enqueueSlot) sends whatever the slot holds when it runs, and
 * clears the slot only when the slot still holds the save it sent; a newer save that arrived meanwhile is sent next.
 * So only the newest contents are ever sent, an older one can never land after a newer one, and the newest always gets
 * its chance: a failed send keeps the slot for Retry, and a cancel drops it.
 *
 * Every open of the file (to read, or to write keeping the contents) starts from the slot while there is one, so what
 * another app reads is what it last saved, whether its upload is waiting, retrying, failed or its job long pruned. Ids
 * and paths only, beside the description's name and type (the queue's other copies keep the same).
 */
object WriteBacks {
    const val SLOT = "slot:"
    private const val RECORD = "record.json"
    private const val BIN = ".bin"
    private const val META = ".json"

    /* A file's slot: its workspace and node, both ids; also its folder's name and its job's unique name. */
    fun slotOf(workspaceId: String, nodeId: String): String = "writeback-${workspaceId.lowercase()}-${nodeId.lowercase()}"

    /* What a slot's upload needs: the file, as it was when the app opened it (the job looks it up again), and its family. */
    data class Target(
        val workspaceId: String, val nodeId: String, val name: String, val mime: String?, val folder: String,
        val family: String? = null, val familyWorkspace: String? = null,
    )

    /*
     * A save: its generation (counts up while the slot holds saves, to tell newer from older) and its id, never reused,
     * not even after the slot empties and counts from one again (its contents' file name, its upload's ledger key, and
     * what landing compares).
     */
    data class Pending(val slot: String, val generation: Long, val id: String, val target: Target) {
        /* The upload ledger's key for this save: its landed row, if an answer was lost, belongs to this save alone. */
        val ledger get() = "$slot#$id"
    }

    /* The ledger keys of every save `slot` has had: its landed rows, superseded saves' included, go when it empties. */
    fun ledgerOf(slot: String, job: String) = job.startsWith("$slot#")

    /* The save a generation file (a job's or a failed row's `file`) holds: its id. */
    fun idOf(file: String?): String? = file?.let { File(it).name }?.takeIf { it.endsWith(BIN) }?.removeSuffix(BIN)

    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    private fun lockOf(slot: String) = locks.getOrPut(slot) { ReentrantLock() }

    fun dir(context: Context, slot: String) = File(context.filesDir, "queue/$slot")

    /* Where the slot's pending save's contents are (what its job, the panel and Cancel name); a path to nothing if none. */
    fun contentOf(context: Context, slot: String): File = lockOf(slot).withLock {
        val dir = dir(context, slot)
        current(dir, slot)?.let { File(dir, it.id + BIN) } ?: File(dir, "none$BIN")
    }

    private fun describe(json: JSONObject, slot: String) = Pending(slot, json.getLong("generation"), json.getString("id"), Target(
        json.getString("workspaceId"), json.getString("nodeId"), json.getString("name"), json.opt("mime") as? String, json.getString("folder"),
        json.opt("family") as? String, json.opt("familyWorkspace") as? String,
    ))

    private fun read(file: File, slot: String): Pending? = runCatching { describe(JSONObject(file.readText()), slot) }.getOrNull()

    /*
     * The slot's pending save, under its lock: the one the record names, its contents there; a complete newer generation
     * a save left unpublished (it died before the record's rename) is published first. Generations neither names go.
     */
    private fun current(dir: File, slot: String): Pending? {
        if (!dir.isDirectory) return null
        val published = read(File(dir, RECORD), slot)?.takeIf { File(dir, it.id + BIN).isFile }
        val newest = dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty()
            .mapNotNull { read(it, slot) }.filter { File(dir, it.id + BIN).isFile }.maxByOrNull { it.generation }
        val pending = if (newest != null && (published == null || newest.generation > published.generation)) {
            publish(dir, newest.id)
            newest
        } else published
        val keep = pending?.id
        dir.listFiles()?.forEach { f ->
            val id = when {
                f.name.endsWith(BIN) -> f.name.removeSuffix(BIN)
                f.name.endsWith(META) && f.name != RECORD -> f.name.removeSuffix(META)
                f.name.endsWith(".incoming") -> ""
                else -> return@forEach
            }
            if (id != keep) f.delete()
        }
        return pending
    }

    /* The record names the generation `id`: its description copied beside and renamed into place, one atomic step. */
    private fun publish(dir: File, id: String) {
        val incoming = File(dir, "$RECORD.incoming")
        File(dir, id + META).copyTo(incoming, overwrite = true)
        check(incoming.renameTo(File(dir, RECORD))) { "The save couldn't be kept." }
    }

    /* The slot's pending save, if it has one. */
    fun pending(context: Context, slot: String): Pending? = lockOf(slot).withLock { current(dir(context, slot), slot) }

    /* Tests: runs right after a save's contents and description are in place, before the record names them. */
    @Volatile internal var afterContent: (() -> Unit)? = null

    /*
     * `edit`'s bytes become the slot's newest save: a new generation, its contents and its description each renamed into
     * place, then published by the record's rename, under the slot's lock and only while the account `accountGeneration`
     * names is still the one on the phone (Reservations.whileAccount: an account wipe moves it, so a save racing a sign-out
     * writes nothing back). Null when the account left.
     */
    fun save(context: Context, accountGeneration: Long, target: Target, edit: File): Pending? = Reservations.whileAccount(accountGeneration) {
        val slot = slotOf(target.workspaceId, target.nodeId)
        lockOf(slot).withLock {
            val dir = dir(context, slot).also { it.mkdirs() }
            // Above every generation the slot holds (a cancelled record's newer saves included), so it is the newest.
            val generation = maxOf(current(dir, slot)?.generation ?: 0L,
                dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot)?.generation }.maxOrNull() ?: 0L) + 1
            val id = java.util.UUID.randomUUID().toString()
            val contents = File(dir, "$id$BIN.incoming")
            if (!edit.renameTo(contents)) edit.copyTo(contents, overwrite = true)
            check(contents.renameTo(File(dir, id + BIN))) { "The save couldn't be kept." }
            val description = JSONObject().put("generation", generation).put("id", id).put("workspaceId", target.workspaceId).put("nodeId", target.nodeId)
                .put("name", target.name).put("mime", target.mime ?: JSONObject.NULL).put("folder", target.folder)
                .put("family", target.family ?: JSONObject.NULL).put("familyWorkspace", target.familyWorkspace ?: JSONObject.NULL)
            val written = File(dir, "$id$META.incoming").apply { writeText(description.toString()) }
            check(written.renameTo(File(dir, id + META))) { "The save couldn't be kept." }
            afterContent?.invoke()
            publish(dir, id)
            current(dir, slot)
            Pending(slot, generation, id, target)
        }
    }

    /* A copy of the slot's newest save in `dest` (an open starts from it); false when there is none. */
    fun copyTo(context: Context, slot: String, dest: File): Boolean = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val pending = current(dir, slot) ?: return false
        dest.parentFile?.mkdirs()
        File(dir, pending.id + BIN).copyTo(dest, overwrite = true)
        true
    }

    /*
     * The newest save to send: its description and a copy of its contents of its own (sending-<id>), so the generation
     * going meanwhile (a newer save replacing it) never changes or removes the bytes under the upload. Null when empty.
     */
    fun take(context: Context, slot: String): Pair<Pending, File>? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val pending = current(dir, slot) ?: return null
        val sending = File(dir, "sending-${pending.id}")
        File(dir, pending.id + BIN).copyTo(sending, overwrite = true)
        pending to sending
    }

    /*
     * The save `id` landed: the slot is cleared only while it still holds that save (a newer save stays to be sent next),
     * by id, so a save made after the slot emptied (its generation counting from one again) is never taken for it. Under
     * the slot's lock, inside the account's (the caller's forItsAccount). The save still pending after, if any.
     */
    fun landed(context: Context, slot: String, id: String): Pending? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val held = current(dir, slot)
        if (held == null || held.id == id) { dir.deleteRecursively(); null } else {
            dir.listFiles()?.filter { it.name.startsWith("sending-") }?.forEach { it.delete() }
            held
        }
    }

    /*
     * Where every close callback of another app's edit runs (personal and family alike): one thread of its own, so saves
     * keep the order the app closed them in, and copying a large file under a slot's lock never holds up the main thread.
     */
    val closes: android.os.Handler by lazy { android.os.Handler(android.os.HandlerThread("HushOSSaves").apply { start() }.looper) }

    /*
     * Slots a job landed while this process ran: the provider's own vault, which didn't send it, may still hold the
     * version before, so its next read of the file checks the version with the server first (then `caughtUp`).
     */
    private val landedHere = ConcurrentHashMap<String, Long>()
    private val landings = java.util.concurrent.atomic.AtomicLong()

    /* A slot's save landed: a landing count of its own, so a read refreshed before it never takes it for seen. */
    fun noteLanded(slot: String) { landedHere[slot] = landings.incrementAndGet() }

    /* The slot's latest landing not caught up with, if any: what a read refreshes for, and then says it saw. */
    fun landedSince(slot: String): Long? = landedHere[slot]

    /* A read refreshed after landing `seen`: only that landing is caught up with, never one that came during the refresh. */
    fun caughtUp(slot: String, seen: Long) { landedHere.remove(slot, seen) }

    /* The slot's saves dropped (its family ended): under its lock, so a save landing in it meanwhile is either kept whole or gone. */
    fun drop(context: Context, slot: String) = lockOf(slot).withLock { dir(context, slot).deleteRecursively() }

    /*
     * The save the slot's record names now, read without its lock (the record changes by one rename, so it is whole):
     * what a cancel pressed now cancels, before any save that arrives after it. Null when none is published.
     */
    fun publishedId(context: Context, slot: String): String? = read(File(dir(context, slot), RECORD), slot)?.id

    /*
     * A cancel of the save `id` (what the slot held when it was pressed), under the slot's lock: that save and every older
     * one go, and only those; a save made after the cancel was pressed stays pending, published if it was waiting behind
     * a cancelled record. Nothing when `id` is gone already (it landed, or a newer save replaced it). The save left, if any.
     */
    fun cancelThrough(context: Context, slot: String, id: String?): Pending? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        if (id == null || !dir.isDirectory) return@withLock current(dir, slot)
        val through = read(File(dir, id + META), slot)?.generation ?: return@withLock current(dir, slot)
        dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot) }.filter { it.generation <= through }.forEach {
            File(dir, it.id + BIN).delete()
            File(dir, it.id + META).delete()
        }
        if ((read(File(dir, RECORD), slot)?.generation ?: Long.MAX_VALUE) <= through) File(dir, RECORD).delete()
        val left = current(dir, slot)
        // Nothing left to send and no upload copy in use: the slot goes.
        if (left == null && dir.listFiles().orEmpty().none { it.name.startsWith("sending-") }) dir.deleteRecursively()
        left
    }

    /*
     * What a listing shows of a file with a pending save: that save's size and when it was kept, so the size and date
     * Files shows are those of the bytes a read returns. Null when the file has none (no lock taken for a file without a slot).
     */
    fun pendingMeta(context: Context, slot: String): Pair<Long, Long>? {
        val dir = dir(context, slot)
        if (!dir.isDirectory) return null
        return lockOf(slot).withLock { current(dir, slot)?.let { File(dir, it.id + BIN) }?.let { it.length() to it.lastModified() } }
    }

    /*
     * A failed save's row dismissed (`file`, its generation): only that save goes. While it is still the pending one the
     * slot goes with it (nothing newer to keep); a newer pending save is never touched.
     */
    fun discard(context: Context, slot: String, file: String?) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val held = current(dir, slot) ?: return@withLock
        if (held.id == idOf(file)) dir.deleteRecursively()
    }
}
