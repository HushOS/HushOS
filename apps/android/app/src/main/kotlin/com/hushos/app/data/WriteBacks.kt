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

    /* Whether a queue folder is a file's slot (by its name). */
    fun isSlot(name: String) = name.startsWith("writeback-")

    /* A file's slot: its workspace and node, both ids; also its folder's name and its job's unique name. */
    fun slotOf(workspaceId: String, nodeId: String): String = "writeback-${workspaceId.lowercase()}-${nodeId.lowercase()}"

    /* What a slot's upload needs: the file, as it was when the app opened it (the job looks it up again), and its family. */
    data class Target(
        val workspaceId: String, val nodeId: String, val name: String, val mime: String?, val folder: String,
        val family: String? = null, val familyWorkspace: String? = null,
        /* The drive's top folder when the file is in this account's own drive: its listing is watched as "root" too. */
        val root: String? = null,
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

    /*
     * The save number a generation's id carries (`n<number>-<random>`, as `stage` names it), so a failed row naming its file
     * and a ledger key naming its id (`<slot>#<id>`) say which save they are once its description is gone. Null otherwise.
     */
    fun numberOfId(id: String?): Long? = id?.takeIf { it.startsWith("n") }?.drop(1)?.substringBefore('-')?.toLongOrNull()

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
        json.opt("family") as? String, json.opt("familyWorkspace") as? String, json.opt("root") as? String,
    ))

    private fun read(file: File, slot: String): Pending? = runCatching { describe(JSONObject(file.readText()), slot) }.getOrNull()

    /*
     * The slot's pending save, under its lock, read only (what reads and listings take; nothing is written): the one the
     * record names, its contents there, or a complete newer generation a save left unpublished (it died before the
     * record's rename), which `recovered` publishes on a path the account's lock guards.
     */
    private fun current(dir: File, slot: String): Pending? {
        if (!dir.isDirectory) return null
        val bounds = numbersOf(dir, slot).takeIf { !it.unknown } ?: return null
        val through = maxOf(bounds.landed, bounds.cancelled)
        val published = read(File(dir, RECORD), slot)?.takeIf { File(dir, it.id + BIN).isFile && it.generation > through }
        val newest = dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty()
            .mapNotNull { read(it, slot) }.filter { File(dir, it.id + BIN).isFile && it.generation > through }.maxByOrNull { it.generation }
        return if (newest != null && (published == null || newest.generation > published.generation)) newest else published
    }

    /*
     * The slot's pending save as `current` finds it, made so on disk: a complete newer generation published, generations
     * neither names deleted. Only on paths the account's lock guards (a save, a take, a landing, a cancel, a dismissal,
     * a reconcile), under the slot's lock.
     */
    private fun recovered(dir: File, slot: String): Pending? {
        if (!dir.isDirectory) return null
        // A save a cancel took is never pending again, whatever is left of it on disk.
        // A save at or below the slot's durable bounds (the newest landed, a cancel's) is never pending again, whatever is
        // left of it on disk.
        // Bounds that can't be read: nothing is pending, and nothing is tidied, until they are rebuilt (repaired).
        val bounds = numbersOf(dir, slot).takeIf { !it.unknown } ?: return null
        val through = maxOf(bounds.landed, bounds.cancelled)
        val published = read(File(dir, RECORD), slot)?.takeIf { File(dir, it.id + BIN).isFile && it.generation > through }
        val newest = dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty()
            .mapNotNull { read(it, slot) }.filter { File(dir, it.id + BIN).isFile && it.generation > through }.maxByOrNull { it.generation }
        val pending = if (newest != null && (published == null || newest.generation > published.generation)) {
            // Its record written now; refused (a full disk), it is still the pending save, and a later look writes it.
            runCatching { publish(dir, newest.id) }
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
        fault?.invoke("record")
        val incoming = File(dir, "$RECORD.incoming")
        File(dir, id + META).copyTo(incoming, overwrite = true)
        check(incoming.renameTo(File(dir, RECORD))) { "The save couldn't be kept." }
    }

    /* The slot's pending save, if it has one. */
    fun pending(context: Context, slot: String): Pending? = lockOf(slot).withLock { current(dir(context, slot), slot) }

    /* Tests: runs as a save is about to make its slot's own id (a new slot's first write). */
    @Volatile internal var beforeSlotId: (() -> Unit)? = null

    /* A save's file as a failed row keeps it (FailedTransfer.stage), and back. */
    fun encodeTarget(t: Target, familyEpoch: Long? = null, number: Long? = null, account: String? = null, quarantined: Long? = null): String = JSONObject().put("number", number ?: JSONObject.NULL).put("quarantined", quarantined ?: JSONObject.NULL).put("workspaceId", t.workspaceId).put("nodeId", t.nodeId).put("name", t.name)
        .put("mime", t.mime ?: JSONObject.NULL).put("folder", t.folder).put("family", t.family ?: JSONObject.NULL)
        .put("familyWorkspace", t.familyWorkspace ?: JSONObject.NULL).put("root", t.root ?: JSONObject.NULL)
        .put("familyEpoch", familyEpoch ?: JSONObject.NULL).put("account", account ?: JSONObject.NULL).toString()

    /*
     * A staging row kept aside by a rebuild of unreadable bounds (its save can't be told from one landed or cancelled):
     * the ceiling those bounds were rebuilt at. Never read as contents, never sent unless its Retry is pressed, and
     * retired only by a landing or cancel above that ceiling. Null for any other row.
     */
    fun quarantinedAt(json: String): Long? = runCatching { JSONObject(json).opt("quarantined") as? Number }.getOrNull()?.toLong()

    private fun quarantine(json: String, ceiling: Long): String = JSONObject(json).put("quarantined", ceiling).toString()

    /* Whether a staging row numbered `number` goes with a bound at `through`: at or below it, and not kept aside at or above it. */
    fun retiredBy(stage: String, through: Long): Boolean =
        (stagedNumber(stage) ?: 0L) <= through && quarantinedAt(stage).let { it == null || through > it }

    /* The account (its user id) an edit's target names: the one signed in as the edit was made. Null for none named. */
    fun accountOf(json: String): String? = runCatching { JSONObject(json).opt("account") as? String }.getOrNull()

    /* The save number a staging row's save was given as its app closed the file. */
    fun stagedNumber(json: String): Long? = runCatching { JSONObject(json).opt("number") as? Number }.getOrNull()?.toLong()

    /* The family folder's revocation count a staging row was made under (null for this account's own drive). */
    fun stagedEpoch(json: String): Long? = runCatching { JSONObject(json).opt("familyEpoch") as? Number }.getOrNull()?.toLong()

    fun decodeTarget(json: String): Target? = runCatching {
        val o = JSONObject(json)
        Target(o.getString("workspaceId"), o.getString("nodeId"), o.getString("name"), o.opt("mime") as? String, o.getString("folder"),
            o.opt("family") as? String, o.opt("familyWorkspace") as? String, o.opt("root") as? String)
    }.getOrNull()

    /* Tests: runs right after a save's contents and description are in place, before the record names them. */
    @Volatile internal var afterContent: (() -> Unit)? = null

    /*
     * `edit`'s bytes become the slot's newest save: a new generation, its contents and its description each renamed into
     * place, then published by the record's rename, under the slot's lock and only while the account `accountGeneration`
     * names is still the one on the phone (Reservations.whileAccount: an account wipe moves it, so a save racing a sign-out
     * writes nothing back). Null when the account left.
     */
    fun save(context: Context, accountGeneration: Long, target: Target, edit: File): Pending? =
        reserve(context, slotOf(target.workspaceId, target.nodeId), accountGeneration)?.let { stage(context, accountGeneration, target, edit, it) }

    /* A save older than what its file's slot already holds or landed: never kept (a newer one stands). */
    class Superseded : Exception("A newer save of this file stands.")

    /* A save kept aside whose file has something newer now: not sent; its row stays for the person to Dismiss. */
    class Moot : Exception("A newer save of this file stands.")

    /*
     * Tests: runs at each step of keeping a save ("copy", "fsync", "json", "record", "delete"), of a landing ("landed-copy",
     * "landed-mark", "landed-retire": after each), of a dismissal ("dismiss", as it begins), of a slot's clearing ("clear",
     * once its contents went) and of the others named where they run, to fail it there.
     */
    @Volatile internal var fault: ((String) -> Unit)? = null

    /*
     * `edit`'s bytes become the slot's save numbered `number` (its order, given as the app closed the file: `reserve`):
     * copied into a generation of its own and synced, its description written and synced, then published by the record's
     * rename, under the slot's lock and only while the account `accountGeneration` names is still the one on the phone
     * (Reservations.whileAccount: a save racing a sign-out writes nothing back). The edit is deleted only after all that,
     * so a failure at any step leaves it whole for the caller to keep (and the earlier save pending as it was). A number
     * no newer than the slot's newest save, landed or pending, keeps nothing (Superseded). Null when the account left.
     */
    fun stage(context: Context, accountGeneration: Long, target: Target, edit: File, number: Long,
              intoEmptyAbove: Long? = null, publishUnder: ((() -> Pending?) -> Pending?)? = null): Pending? {
        val slot = slotOf(target.workspaceId, target.nodeId)
        if (publishUnder == null) return Reservations.whileAccount(accountGeneration) {
            lockOf(slot).withLock {
                val id = write(context, slot, target, edit, number, staged = false, intoEmptyAbove)
                unlessPublished(context, slot, id) { publishGeneration(context, slot, target, edit, number, id, staged = false, intoEmptyAbove) }
            }
        }
        // A family's: copied and synced under the slot's lock alone (staged: no look publishes or removes it), then published
        // under whatever `publishUnder` holds (the copies lock a revocation's cleanup takes, its recheck first) for the short
        // rename; not published (revoked meanwhile, the account gone, a step failing), the copy goes.
        val id = Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock { write(context, slot, target, edit, number, staged = true, intoEmptyAbove) } } ?: return null
        afterStaged?.invoke()
        var kept: Pending? = null
        try {
            kept = publishUnder { Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock { unlessPublished(context, slot, id) { publishGeneration(context, slot, target, edit, number, id, staged = true, intoEmptyAbove) } } } }
            return kept
        } finally {
            if (kept == null) lockOf(slot).withLock { dir(context, slot).let { File(it, id + BIN + STAGED).delete(); File(it, id + META + STAGED).delete() } }
        }
    }

    /*
     * `publish` of generation `id`; failing before its record named it, the generation goes (the edit, kept by the caller
     * with its row, is that save from here, so no look publishes a copy its Retry would then find superseding it).
     */
    private fun unlessPublished(context: Context, slot: String, id: String, publish: () -> Pending): Pending = try {
        publish()
    } catch (failure: Exception) {
        // (A death has no say here: what it leaves is a complete generation the next look publishes, or nothing.)
        val dir = dir(context, slot)
        if (read(File(dir, RECORD), slot)?.id != id) { File(dir, id + BIN).delete(); File(dir, id + META).delete() }
        throw failure
    }

    /* A family save's generation copied but not yet published: no look takes it as pending or removes it. */
    private const val STAGED = ".staged"

    /* `edit`'s bytes and description written into a new generation of the slot (synced), named `staged` if so. Its id. */
    private fun write(context: Context, slot: String, target: Target, edit: File, number: Long, staged: Boolean, intoEmptyAbove: Long? = null): String {
        val dir = dir(context, slot).also { it.mkdirs() }
        // The slot's own id for as long as it exists: what tells a cancel pressed on an earlier slot of the file from this one.
        File(dir, INCARNATION).takeIf { !it.isFile }?.let { file ->
            beforeSlotId?.invoke()
            val incoming = File(dir, "$INCARNATION.incoming").apply { writeText(java.util.UUID.randomUUID().toString()) }
            check(incoming.renameTo(file)) { "The save couldn't be kept." }
        }
        superseded(context, slot, dir, number, intoEmptyAbove)
        val suffix = if (staged) STAGED else ""
        val id = "n$number-" + java.util.UUID.randomUUID()
        // A step failing leaves nothing of this generation (its contents are a whole plaintext copy): the edit stays.
        try {
            writeGeneration(dir, target, edit, number, id, suffix)
        } catch (failure: Exception) {
            for (name in listOf("$id$BIN.incoming", id + BIN + suffix, "$id$META.incoming", id + META + suffix)) File(dir, name).delete()
            throw failure
        }
        return id
    }

    private fun writeGeneration(dir: File, target: Target, edit: File, number: Long, id: String, suffix: String) {
        val contents = File(dir, "$id$BIN.incoming")
        fault?.invoke("copy")
        java.io.FileOutputStream(contents).use { out ->
            edit.inputStream().use { it.copyTo(out) }
            fault?.invoke("fsync")
            out.fd.sync()
        }
        check(contents.renameTo(File(dir, id + BIN + suffix))) { "The save couldn't be kept." }
        val description = JSONObject().put("generation", number).put("id", id).put("workspaceId", target.workspaceId).put("nodeId", target.nodeId)
            .put("name", target.name).put("mime", target.mime ?: JSONObject.NULL).put("folder", target.folder)
            .put("family", target.family ?: JSONObject.NULL).put("familyWorkspace", target.familyWorkspace ?: JSONObject.NULL)
            .put("root", target.root ?: JSONObject.NULL)
        fault?.invoke("json")
        val written = File(dir, "$id$META.incoming")
        java.io.FileOutputStream(written).use { out -> out.write(description.toString().toByteArray()); out.fd.sync() }
        check(written.renameTo(File(dir, id + META + suffix))) { "The save couldn't be kept." }
    }

    /*
     * Reconcile, as the process starts: family generations copied but never published (`.staged`: a process that died, or a
     * step that failed before its cleanup) go, each a whole plaintext copy no look would ever take or remove. One written
     * to in the last minutes may be a save of this process under way, and stays.
     */
    fun dropStaged(context: Context) {
        val idle = System.currentTimeMillis() - 10 * 60 * 1000L
        File(context.filesDir, "queue").listFiles()?.filter { isSlot(it.name) }?.forEach { dir ->
            lockOf(dir.name).withLock { dir.listFiles { f -> f.name.endsWith(STAGED) && f.lastModified() < idle }?.forEach { it.delete() } }
        }
    }

    /* A number no newer than the slot's newest save, pending or landed or cancelled, keeps nothing; bounds unknown keep nothing either. */
    private fun superseded(context: Context, slot: String, dir: File, number: Long, intoEmptyAbove: Long? = null) {
        val numbers = repaired(context, slot) ?: throw IllegalStateException("The save couldn't be kept.")
        val pending = recovered(dir, slot)
        // A save kept aside (its ceiling `intoEmptyAbove`) goes only into a slot with nothing of the file newer than it:
        // no save pending or being sent, nothing landed or cancelled since it was kept aside. Else it is moot, and stays.
        if (intoEmptyAbove != null && (pending != null || dir.listFiles().orEmpty().any { it.name.startsWith("sending-") } ||
                numbers.landed > intoEmptyAbove || numbers.cancelled > intoEmptyAbove)) throw Moot()
        if (number <= maxOf(pending?.generation ?: 0L, numbers.landed, numbers.cancelled)) throw Superseded()
    }

    /* The generation `id` published as the slot's save (a staged one checked again and named for good first); the edit goes. */
    private fun publishGeneration(context: Context, slot: String, target: Target, edit: File, number: Long, id: String, staged: Boolean,
                                  intoEmptyAbove: Long? = null): Pending {
        val dir = dir(context, slot)
        if (staged) {
            superseded(context, slot, dir, number, intoEmptyAbove)
            check(File(dir, id + BIN + STAGED).renameTo(File(dir, id + BIN)) && File(dir, id + META + STAGED).renameTo(File(dir, id + META))) { "The save couldn't be kept." }
        }
        afterContent?.invoke()
        publish(dir, id)
        recovered(dir, slot)
        // Kept: only now does the edit go, with its target beside it (a failure to delete it leaves a stray copy, never a
        // lost save: the next reconcile finds its number kept and deletes it).
        runCatching { fault?.invoke("delete"); discardEdit(edit) }
        return Pending(slot, number, id, target)
    }

    const val NUMBERS = "writeback-numbers"

    /*
     * Where another app's open of a file writes (filesDir/edits: durable, an account file a sign-out wipes; a family's under
     * edits/family/<workspace>, which its revocation deletes): `<id>`, with the file it would replace beside it (`<id>.json`,
     * written as the edit is made, while there is room). Closed, it is renamed `<id>.<number>.closed` (a rename needs no
     * room, so this holds on a full disk): from then on it is that save until it is kept in the slot, dismissed, or let
     * go of with its family or account, and nothing else deletes it.
     */
    const val EDITS = "edits"

    /* Tests: runs as an open has chosen which kept contents to start from, before copying them. */
    @Volatile internal var afterNewestChosen: (() -> Unit)? = null

    /* Every closed edit of `slot` on disk, by the number in its name: the saves never kept in the slot. Never throws. */
    fun closedEditsOf(context: Context, slot: String): List<Pair<Long, File>> = runCatching {
        File(context.filesDir, EDITS).walkTopDown().filter { it.isFile && it.name.endsWith(".closed") }.mapNotNull { closed ->
            val number = closedNumber(closed) ?: return@mapNotNull null
            val target = runCatching { decodeTarget(sidecarOf(closed).readText()) }.getOrNull() ?: return@mapNotNull null
            if (slotOf(target.workspaceId, target.nodeId) == slot) number to closed else null
        }.toList()
    }.getOrDefault(emptyList())

    /* Tests: the numbers given in this process forgotten, as a restart forgets them. */
    internal fun forgetReservedHere() = forgetHere()

    /* A new edit in `dir`, its target written beside it. */
    fun editIn(dir: File, target: Target, account: String?, id: String = java.util.UUID.randomUUID().toString()): File {
        dir.mkdirs()
        val incoming = File(dir, "$id.json.incoming").apply { writeText(encodeTarget(target, account = account)) }
        check(incoming.renameTo(File(dir, "$id.json"))) { "The edit couldn't be made." }
        return File(dir, id)
    }

    /* An open of this account's own file: its edit under filesDir/edits/personal/<node>. */
    fun personalEdit(context: Context, target: Target, account: String?): File = editIn(editDirOf(context, target), target, account)

    /* Where `target`'s edits live: edits/personal/<node>, or edits/family/<workspace>/<node> (FamilyCopies.edits). */
    private fun editDirOf(context: Context, target: Target): File = File(context.filesDir,
        target.familyWorkspace?.let { "$EDITS/family/${it.lowercase()}/${target.nodeId.lowercase()}" } ?: "$EDITS/personal/${target.nodeId.lowercase()}")

    /* The file an edit would replace, written beside it as it was made. */
    fun sidecarOf(edit: File): File = File(edit.parentFile, edit.name.substringBefore('.') + ".json")

    /* A closed edit: renamed with its save's number (one rename, no room needed); the edit itself if the rename failed. */
    fun close(edit: File, number: Long): File {
        val closed = File(edit.parentFile, "${edit.name}.$number.closed")
        if (runCatching { fault?.invoke("close") }.isFailure) return edit
        return if (edit.renameTo(closed)) closed else edit
    }

    /*
     * Whether `name` is an edit that holds a save (as against its target, a copy being made, or anything else): one still
     * open or never closed (`<id>`, `rescued-<id>`), closed (`<id>.<number>.closed`) or kept aside (`<id>.q<number>`).
     * Every sweep of edits and their targets asks this, so none deletes a target an edit still needs.
     */
    fun isRetainedEdit(name: String): Boolean = RETAINED.any { it.matches(name) }

    private val RETAINED = listOf(Regex("^[^.]+$"), Regex("^[^.]+\\.\\d+\\.closed$"), Regex("^[^.]+\\.q\\d+$"))

    /* The save number a closed edit was renamed with. */
    fun closedNumber(file: File): Long? = Regex("^[^.]+\\.(\\d+)\\.closed$").find(file.name)?.groupValues?.get(1)?.toLong()

    /* An edit and its target gone: only once its save was kept, dismissed, or let go of. */
    fun discardEdit(edit: File) {
        edit.delete()
        sidecarOf(edit).delete()
    }

    /* Whether the slot already holds or landed a save numbered at or above `number` (a closed edit of it is then moot). */
    fun keptAtOrAbove(context: Context, slot: String, number: Long): Boolean = lockOf(slot).withLock {
        readNumbers(context, slot).let { held -> !held.unknown && number <= maxOf(current(dir(context, slot), slot)?.generation ?: 0L, held.landed, held.cancelled) }
    }

    /*
     * Per slot, kept past it (an account file a sign-out wipes): the last number given, the newest landed, every number a
     * cancel took (`cancelled`), and the landing a read hasn't caught up with yet. One file, so the landed bound and its
     * landing marker change together, by one rename: no state on disk says a save landed while a read doesn't know it.
     */
    private data class Numbers(val reserved: Long, val landed: Long, val cancelled: Long = 0L, val landing: Landing? = null, val unknown: Boolean = false)

    /*
     * A numbers file that is there but can't be read or parsed: the slot's bounds are unknown. Every bound reads as passed
     * (nothing pending or served, a sending job stops: isCancelled) and its landing as one a read must refresh for, while
     * nothing that would act on them (keep, retire, record, tidy) runs until they are rebuilt (repaired). Only a file
     * that isn't there means none.
     */
    private val UNKNOWN = Numbers(Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE, Landing("unreadable", null), unknown = true)

    /*
     * The slot's numbers, rebuilt first if they can't be read, under the slot's lock and only on a path the account's own
     * lock guards (a save, a landing, a cancel, a job's take, a reconcile): every generation on disk counts as passed (its
     * newest number the landed and cancelled bound, so none is pending or sent again: a save still pending then can't be
     * told from one cancelled or landed, and goes), with a landing a read refreshes for. Null when even that is refused.
     */
    private fun repaired(context: Context, slot: String): Numbers? {
        val held = readNumbers(context, slot)
        if (!held.unknown) return held
        // Known in this process: those bounds again, exactly (a save above them stays pending).
        lastKnown[slot]?.let { known -> return runCatching { writeNumbers(context, slot, known); known }.getOrNull() }
        val dir = dir(context, slot)
        val generations = dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot) }
            .filter { File(dir, it.id + BIN).isFile }
        val records = FailedTransfers.of(context)
        val rows = runCatching { records.all() }.getOrDefault(emptyList()).filter { it.slot == slot && it.stage != null }
        val closed = closedEditsOf(context, slot)
        // Not known: whatever is on disk of the file's saves (generations, closed edits, staging rows, copies being sent)
        // can't be told from saves landed or cancelled, so the bounds cover all of it (none is read or sent from where it
        // is) and each is kept aside instead (quarantined): an edit of its own, never closed (never read as contents), with
        // a staging row ("The save wasn't kept.") that keeps its own number, to Retry or Dismiss. A Retry sends it only if
        // nothing newer of the file was kept aside (TransferQueue.retry). The newest complete generation leaves the slot.
        // (A generation whose description can't be read names no file to send to, and isn't kept.)
        val sending = dir.listFiles { f -> f.name.startsWith("sending-") }.orEmpty().mapNotNull { numberOfId(it.name.removePrefix("sending-")) }
        // Edits set aside before (a rebuild that stopped between an edit's rename and its row): `<id>.q<number>`.
        val asides = runCatching { File(context.filesDir, EDITS).walkTopDown().filter { it.isFile && Regex("^[^.]+\\.q(\\d+)$").matches(it.name) }.toList() }
            .getOrDefault(emptyList()).mapNotNull { aside ->
                val target = runCatching { decodeTarget(sidecarOf(aside).readText()) }.getOrNull() ?: return@mapNotNull null
                if (slotOf(target.workspaceId, target.nodeId) != slot) null else Triple(aside, target, aside.name.substringAfterLast(".q").toLongOrNull() ?: 0L)
            }
        val ceiling = (generations.map { it.generation } + closed.map { it.first } + rows.mapNotNull { stagedNumber(it.stage!!) } + sending + asides.map { it.third }).maxOrNull() ?: 0L
        val account = Shared.session(context)?.userId
        fun kept(edit: File): Boolean = runCatching { records.all() }.getOrDefault(emptyList()).any { it.file == edit.path }
        generations.maxByOrNull { it.generation }?.let { save ->
            val rescued = File(editDirOf(context, save.target), "rescued-${save.id}")
            // There only once copied whole: written beside it and synced, then renamed into place (a copy cut short leaves
            // only the one beside it, which is never taken for the rescue and is made again).
            if (!rescued.isFile) {
                editIn(rescued.parentFile!!, save.target, account, rescued.name)
                val copying = File(rescued.parentFile, "${rescued.name}.incoming")
                try {
                    val source = File(dir, save.id + BIN)
                    java.io.FileOutputStream(copying).use { out ->
                        source.inputStream().use { input ->
                            // Tests: "rescue" fails it halfway, as a death or a full disk would.
                            val half = source.length() / 2
                            val buffer = ByteArray(64 * 1024)
                            var copied = 0L
                            var faulted = false
                            while (true) {
                                if (!faulted && copied >= half) { faulted = true; fault?.invoke("rescue") }
                                val read = input.read(buffer, 0, if (!faulted) minOf(buffer.size.toLong(), half - copied).toInt().coerceAtLeast(1) else buffer.size)
                                if (read < 0) break
                                out.write(buffer, 0, read)
                                copied += read
                            }
                        }
                        out.fd.sync()
                    }
                    check(copying.renameTo(rescued)) { "The save couldn't be kept." }
                } finally {
                    copying.delete()
                }
            }
            // Its row before the bounds move past it: without one (a row refused), nothing is rebuilt yet.
            // A family's: no revocation count is known for it here (a revocation deletes the edit, as it deletes every edit
            // of the folder), so none moves past it.
            if (!kept(rescued) && !TransferQueue.stagingFailed(context, save.target, rescued, Exception("The save wasn't kept."), Reservations.generation,
                    save.generation, save.target.familyWorkspace?.let { Long.MAX_VALUE }, quarantined = ceiling)) return null
            // Kept as the row's edit: out of the slot, so it is never sent from there.
            File(dir, save.id + BIN).delete()
            File(dir, save.id + META).delete()
            if (read(File(dir, RECORD), slot)?.id == save.id) File(dir, RECORD).delete()
        }
        // Closed edits: renamed out of the closed form (`<id>.q<number>`, its number kept in the name) so nothing reads
        // them, each with its row (a row naming it already is moved to the new name and kept aside).
        for ((number, edit) in closed) {
            val aside = File(edit.parentFile, edit.name.substringBefore('.') + ".q$number")
            if (!edit.renameTo(aside)) return null
            val named = rows.firstOrNull { it.file == edit.path }
            if (named != null) {
                runCatching { records.record(named.copy(file = aside.path, stage = quarantine(named.stage!!, ceiling))) }.getOrElse { return null }
            } else {
                val target = runCatching { decodeTarget(sidecarOf(aside).readText()) }.getOrNull() ?: continue
                if (!TransferQueue.stagingFailed(context, target, aside, Exception("The save wasn't kept."), Reservations.generation, number,
                        target.familyWorkspace?.let { Long.MAX_VALUE }, quarantined = ceiling)) return null
            }
        }
        // An edit set aside before without its row: its row now.
        for ((aside, target, number) in asides) {
            if (kept(aside)) continue
            if (!TransferQueue.stagingFailed(context, target, aside, Exception("The save wasn't kept."), Reservations.generation, number,
                    target.familyWorkspace?.let { Long.MAX_VALUE }, quarantined = ceiling)) return null
        }
        // The other staging rows (an edit kept under its open name): kept aside too.
        for (row in runCatching { records.all() }.getOrDefault(emptyList()).filter { it.slot == slot && it.stage != null && quarantinedAt(it.stage) == null }) {
            runCatching { records.record(row.copy(stage = quarantine(row.stage!!, ceiling))) }.getOrElse { return null }
        }
        FailedTransfers.changed()
        val rebuilt = Numbers(ceiling, ceiling, ceiling, Landing(java.util.UUID.randomUUID().toString(), null))
        return runCatching { writeNumbers(context, slot, rebuilt); rebuilt }.getOrNull()
    }

    /* Reconcile and the sweep, under the account's lock: the slot made what `current` reads (recovered). */
    fun recover(context: Context, slot: String) { lockOf(slot).withLock { recovered(dir(context, slot), slot) } }

    /* Reconcile: the slot's numbers rebuilt if they can't be read (repaired). */
    fun repair(context: Context, slot: String) { lockOf(slot).withLock { repaired(context, slot) } }

    private val reservedHere = ConcurrentHashMap<String, Long>()

    /* The numbers last read or written whole, per slot, in this process: what an unreadable file is rebuilt from first. */
    private val lastKnown = ConcurrentHashMap<String, Numbers>()

    /* The account left (AccountStore.wipe): what this process held of its slots goes too. */
    fun forgetHere() { reservedHere.clear(); lastKnown.clear() }

    private fun numbersFile(context: Context, slot: String) = File(context.filesDir, "$NUMBERS/$slot")

    private fun readNumbers(context: Context, slot: String): Numbers = readNumbersAt(numbersFile(context, slot))

    /* The numbers of the slot whose folder is `dir` (queue/<slot> under filesDir): the one place the durable bounds are read. */
    private fun numbersOf(dir: File, slot: String): Numbers = readNumbersAt(File(dir.parentFile?.parentFile, "$NUMBERS/$slot"))

    private fun readNumbersAt(file: File): Numbers {
        if (!file.exists()) return Numbers(0L, 0L)
        return runCatching {
            val lines = file.readText().split("\n")
            val parts = lines[0].trim().split(" ")
            require(parts.size in 2..3)
            val landing = lines.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { Landing(it, lines.getOrNull(2)?.ifEmpty { null }) }
            Numbers(parts[0].toLong(), parts[1].toLong(), parts.getOrNull(2)?.toLong() ?: 0L, landing).also { lastKnown[file.name] = it }
        }.getOrDefault(UNKNOWN)
    }

    /* Written whole and synced, then renamed into place (its folder synced too where the platform lets it): old or new, never half. */
    private fun writeNumbers(context: Context, slot: String, numbers: Numbers) {
        fault?.invoke("numbers")
        val file = numbersFile(context, slot).also { it.parentFile?.mkdirs() }
        val incoming = File(file.parentFile, "$slot.incoming")
        val text = "${numbers.reserved} ${numbers.landed} ${numbers.cancelled}" + (numbers.landing?.let { "\n${it.id}\n${it.version ?: ""}" } ?: "")
        java.io.FileOutputStream(incoming).use { out -> out.write(text.toByteArray()); out.fd.sync() }
        check(incoming.renameTo(file)) { "The save's number couldn't be kept." }
        lastKnown[slot] = numbers
        runCatching {
            val fd = android.system.Os.open(file.parentFile!!.path, android.system.OsConstants.O_RDONLY, 0)
            try { android.system.Os.fsync(fd) } finally { android.system.Os.close(fd) }
        }
    }

    /*
     * A save's order, given as the app closes the file and before anything is kept: above every number the file's saves
     * had, pending, landed, cancelled or given before (kept on disk past the slot, and in memory, so a disk that refuses
     * the write still gives an increasing number). Nothing is published or tidied here, and it never throws. Its one write
     * (the counter) is made only while the account `accountGeneration` names is still on the phone (under the wipe's lock):
     * null when it left, and nothing of it is written.
     */
    fun reserve(context: Context, slot: String, accountGeneration: Long): Long? = Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock {
        // Unreadable and not rebuilt: numbered from what else is on disk, and the counter left alone (never throws).
        val trusted = runCatching { repaired(context, slot) }.getOrNull()
        val held = trusted ?: Numbers(0L, 0L)
        // From what is on disk (the closed edits first: they are the saves, the counter and rows only caches of them), so a
        // counter that couldn't be written, and a restart, never give a number again.
        val onDisk = runCatching {
            val dir = dir(context, slot)
            maxOf(held.reserved, held.landed, held.cancelled, read(File(dir, RECORD), slot)?.generation ?: 0L,
                dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot)?.generation }.maxOrNull() ?: 0L,
                closedEditsOf(context, slot).maxOfOrNull { it.first } ?: 0L,
                runCatching { FailedTransfers.of(context).all() }.getOrDefault(emptyList())
                    .filter { it.slot == slot && it.stage != null }.mapNotNull { stagedNumber(it.stage!!) }.maxOrNull() ?: 0L)
        }.getOrDefault(maxOf(held.reserved, held.landed, held.cancelled))
        val number = maxOf(onDisk, reservedHere[slot] ?: 0L) + 1
        reservedHere[slot] = number
        if (trusted != null) runCatching { writeNumbers(context, slot, held.copy(reserved = number)) }
        number
    } }

    /*
     * The newest contents another app kept of the file, by save number, under the slot's lock (the one a landing and a
     * cancel take, so what is chosen is never deleted before it is used): its pending save, or a closed edit whose save
     * couldn't be kept in the slot (row or not: a row that couldn't be written leaves only the edit), never one at or
     * below the newest landed save or a cancel's bound. Only closed edits: an edit never closed (its close's rename
     * failed, or an open abandoned partway) is never taken for contents, though a row keeps it for a Retry. What a read,
     * every open that keeps the contents and every listing take (`copyNewestTo`, `pendingMeta`). Null when neither.
     */
    private fun newestLocked(context: Context, slot: String): File? {
        val settled = readNumbers(context, slot).takeIf { !it.unknown }?.let { maxOf(it.landed, it.cancelled) } ?: return null
        val staged = closedEditsOf(context, slot).filter { it.first > settled && it.second.isFile }.maxByOrNull { it.first }
        val dir = dir(context, slot)
        val pending = current(dir, slot)
        return when {
            staged != null && (pending == null || staged.first > pending.generation) -> staged.second
            pending != null -> File(dir, pending.id + BIN)
            else -> null
        }
    }

    /* The newest kept contents (newestLocked) copied to `dest`; false when there are none. */
    fun copyNewestTo(context: Context, slot: String, dest: File): Boolean = lockOf(slot).withLock {
        val source = newestLocked(context, slot) ?: return@withLock false
        afterNewestChosen?.invoke()
        dest.parentFile?.mkdirs()
        source.copyTo(dest, overwrite = true)
        true
    }

    /*
     * The newest save to send: its description and a copy of its contents of its own (sending-<id>), so the generation
     * going meanwhile (a newer save replacing it) never changes or removes the bytes under the upload. Null when empty.
     */
    fun take(context: Context, slot: String, accountGeneration: Long): Pair<Pending, File>? = Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock {
        val dir = dir(context, slot)
        // Bounds that can't be read or rebuilt: nothing is taken, and the job tries again later.
        if (dir.isDirectory) repaired(context, slot) ?: throw IllegalStateException("The save couldn't be read.")
        val pending = recovered(dir, slot) ?: return@whileAccount null
        val sending = File(dir, "sending-${pending.id}")
        try {
            File(dir, pending.id + BIN).copyTo(sending, overwrite = true)
        } catch (error: Exception) {
            // Nothing half-copied is left: the save itself stays as it was.
            sending.deleteRecursively()
            throw error
        }
        pending to sending
    } }

    /*
     * The save `id` landed: the slot is cleared only while it still holds that save (a newer save stays to be sent next),
     * by id, so a save made after the slot emptied (its generation counting from one again) is never taken for it. Under
     * the slot's lock, inside the account's (the caller's forItsAccount). The save still pending after, if any.
     */
    fun landed(context: Context, slot: String, id: String, version: String? = null, readCopy: File? = null, generation: Long = 0L): Pending? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        // In an order where no step's end (a death, a write refused) leaves the disk saying "landed" while a read doesn't know
        // it: until the landing marker is written the save is still pending (sent again, or found landed by its ledger); from
        // it on a read refreshes or serves the landed bytes. Only then does anything go.
        // 1. What a read is served from until it has caught up with the server (`landing`): the landed bytes, moved from the
        //    copy that was sent to the read copy of the version they became, when that is known.
        val sending = File(dir, "sending-$id")
        val kept = if (version != null && readCopy != null && sending.isFile) {
            readCopy.parentFile?.mkdirs()
            // Renamed, or copied beside it and renamed: a read takes the read copy by its existence, so it is never there
            // half-written (a copy cut short leaves only the one beside it, deleted here or with the cache).
            sending.renameTo(readCopy) || runCatching {
                val copying = File(readCopy.parentFile, "${readCopy.name}.incoming")
                try {
                    sending.copyTo(copying, overwrite = true)
                    check(copying.renameTo(readCopy))
                } finally {
                    copying.delete()
                }
                true
            }.getOrDefault(false)
        } else false
        fault?.invoke("landed-copy")
        // 2-3. The landing recorded (recordLanding, as every landing is). Refused, nothing below runs (the caller's job tries again).
        if (generation > 0L) recordLanding(context, slot, generation, if (kept) version else null)
        // 4. The slot cleared of it.
        val held = recovered(dir, slot)
        if (held == null || held.id == id) { clearThrough(dir, generation); null } else {
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
     * A file's save landed from its job's own vault: the reader's vault may still hold the version before. Kept on disk
     * with the slot's numbers (filesDir/writeback-numbers/<slot>, with the landed bound) until a read caught up with the server: a
     * landing id of its own (so a read only clears the landing it refreshed for) and the version the save became, when
     * its bytes were kept as that version's read copy. A read that can't reach the server serves those bytes, or fails;
     * never the version before.
     */
    data class Landing(val id: String, val version: String?)

    /*
     * Save `number` of `slot` landed (`version` the version it became, when known), however that was learnt: its own job's
     * completion, or a reservation settled as completed later (a superseded save's included, recoveredLanding). Under the
     * slot's lock: (2) the landing marker and the landed bound in one write (one rename), from which a read refreshes or
     * serves the landed bytes and no save at or below it is kept again; then (3) every save at or below it that never made
     * it into the slot goes, found on disk (a death before that is finished by the next reconcile: retireSettled). A number
     * below the bound, or the bound's own without a version, is already recorded: nothing is written. Throws when the
     * write is refused (nothing is recorded then).
     */
    fun recordLanding(context: Context, slot: String, number: Long, version: String?) = lockOf(slot).withLock {
        val held = repaired(context, slot) ?: throw IllegalStateException("The landing couldn't be kept.")
        if (number < held.landed || (number == held.landed && version == null)) return@withLock
        writeNumbers(context, slot, held.copy(landed = number, landing = Landing(java.util.UUID.randomUUID().toString(), version)))
        fault?.invoke("landed-mark")
        retireStagedThrough(context, slot, number)
        fault?.invoke("landed-retire")
    }

    /*
     * A reservation found completed (Reservations.completed: its answer lost, settled later) whose ledger key is a slot's
     * save: recorded as that save's landing (its version unknown: a read asks the server, or fails), unless that save is
     * still the slot's pending one, whose own job lands it with its version (as it finds the landed row). Inside the
     * account's lock (the ledger's), the slot's taken after it, as everywhere.
     */
    fun recoveredLanding(context: Context, job: String) {
        val slot = job.substringBefore('#').takeIf { isSlot(it) && job.contains('#') } ?: return
        val id = job.substringAfter('#')
        val number = numberOfId(id) ?: return
        lockOf(slot).withLock {
            if (current(dir(context, slot), slot)?.id == id) return
            recordLanding(context, slot, number, null)
        }
    }

    /* The newest save number of `slot` landed (0 when none). */
    fun landedThrough(context: Context, slot: String): Long = readNumbers(context, slot).takeIf { !it.unknown }?.landed ?: 0L

    /* Where an earlier build kept landings apart from the numbers: nothing reads it now; a sign-out still wipes it. */
    const val LANDINGS = "writeback-landings"

    /* Tests: a landing of the file noted, as `landed` notes one. */
    internal fun noteLanding(context: Context, slot: String, version: String?) = lockOf(slot).withLock {
        writeNumbers(context, slot, readNumbers(context, slot).copy(landing = Landing(java.util.UUID.randomUUID().toString(), version)))
    }

    /* The file's latest landing a read hasn't caught up with, if any (read without the lock: the file changes by one rename). */
    fun landing(context: Context, slot: String): Landing? = readNumbers(context, slot).landing

    /* A read caught up with the server after landing `seen`: only that landing goes, never one that came meanwhile. */
    fun caughtUp(context: Context, slot: String, seen: String, accountGeneration: Long) = Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock {
        val held = readNumbers(context, slot)
        if (!held.unknown && held.landing?.id == seen) runCatching { writeNumbers(context, slot, held.copy(landing = null)) }
        Unit
    } }

    /*
     * The slot's saves at or below its durable bounds (landed, cancelled) that never made it into it, gone: what a landing
     * or a cancel that died after its bound left (the next reconcile runs this), under the slot's lock.
     */
    fun retireSettled(context: Context, slot: String) = lockOf(slot).withLock {
        val through = readNumbers(context, slot).takeIf { !it.unknown }?.let { maxOf(it.landed, it.cancelled) } ?: 0L
        if (through > 0L) retireStagedThrough(context, slot, through)
    }

    /*
     * An old slot the sweep found with nothing to send and no job: deleted only if, looked at again under its lock, it still
     * holds no save (one published meanwhile stays).
     */
    fun removeIfEmpty(context: Context, slot: String) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        // A slot whose bounds can't be read is never empty: what it holds waits for them to be rebuilt.
        if (readNumbers(context, slot).unknown) return@withLock
        // Nor one a family save is staged into (copied, its publication to come, into this slot's id).
        if (dir.listFiles().orEmpty().any { it.name.endsWith(STAGED) }) return@withLock
        if (current(dir, slot) == null) dir.deleteRecursively()
    }

    /*
     * A staging row's save `number` dismissed: whatever of it reached the slot (a generation written whose record couldn't be
     * published) goes too, under the slot's lock, so no later look publishes it; any other save is untouched.
     */
    fun dismissSave(context: Context, slot: String, number: Long, edit: File? = null) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        fault?.invoke("dismiss")
        if (dir.isDirectory) {
            dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot) }.filter { it.generation == number }.forEach {
                File(dir, it.id + BIN).delete()
                File(dir, it.id + META).delete()
            }
            if (read(File(dir, RECORD), slot)?.generation == number) File(dir, RECORD).delete()
        }
        // Its edit too, in the same hold of the lock a read chooses under, so a read never chooses an edit going meanwhile.
        edit?.let(::discardEdit)
        Unit
    }

    /* The slot's saves dropped (its family ended): under its lock, so a save landing in it meanwhile is either kept whole or gone. */
    fun drop(context: Context, slot: String) = lockOf(slot).withLock { clear(dir(context, slot)) }

    /*
     * A slot deleted, its generations' contents first: a death partway through leaves no generation whole (contents and
     * description) for a later look to publish again, whatever order the rest goes in.
     */
    private fun clear(dir: File) {
        dir.listFiles { f -> f.name.endsWith(BIN) }?.forEach { it.delete() }
        fault?.invoke("clear")
        dir.deleteRecursively()
    }

    /*
     * A slot whose saves through `through` are settled (landed, cancelled, dismissed) cleared of them: but a family save
     * staged meanwhile (`.staged`, numbered above them: copied, its publication still to come) stays, with what it
     * publishes into (the slot's id), so a landing or a cancel never deletes a newer save under way. With none, it all goes.
     */
    private fun clearThrough(dir: File, through: Long) {
        val inFlight = dir.listFiles { f -> f.name.endsWith(STAGED) && (numberOfId(f.name.substringBefore('.')) ?: 0L) > through }.orEmpty()
        if (inFlight.isEmpty()) return clear(dir)
        dir.listFiles().orEmpty().filter { it !in inFlight && it.name != INCARNATION }.sortedBy { !it.name.endsWith(BIN) }.forEach { it.deleteRecursively() }
    }

    /* Tests: runs once a family save is staged, before it is published. */
    @Volatile internal var afterStaged: (() -> Unit)? = null

    /* What a cancel pressed now takes: the slot's own id, and the save its record names (its generation, id and file). */
    data class Captured(val incarnation: String, val generation: Long, val id: String, val target: Target)

    private const val INCARNATION = "slot-id"

    /*
     * The save the slot's record names now, read without its lock (the record and the slot's id each change by one rename,
     * so they are whole): what a cancel pressed now cancels, before any save that arrives after it, by its generation,
     * which no later save can take away. Null when none is published.
     */
    fun publishedSave(context: Context, slot: String): Captured? {
        val dir = dir(context, slot)
        val incarnation = runCatching { File(dir, INCARNATION).readText() }.getOrNull() ?: return null
        val record = read(File(dir, RECORD), slot) ?: return null
        return Captured(incarnation, record.generation, record.id, record.target)
    }

    /*
     * A cancel of the save `cancelled` (what the slot held when it was pressed), under the slot's lock: that generation and
     * every older one go, and only those, and the bound is kept on the slot whether or not their files are still there (a
     * newer save may have replaced them, while a job still sends one); a save made after the cancel was pressed stays
     * pending. Nothing when the slot it was pressed on is gone, or the account it was pressed in (`accountGeneration`)
     * left (under the wipe's lock: nothing of it is written then). The save left, if any.
     */
    fun cancelThrough(context: Context, slot: String, cancelled: Captured?, accountGeneration: Long): Pending? = Reservations.whileAccount(accountGeneration) { lockOf(slot).withLock {
        val dir = dir(context, slot)
        // The slot Cancel was pressed on, still: one made since the earlier one went counts afresh, and none of it is taken.
        if (cancelled == null || !dir.isDirectory || runCatching { File(dir, INCARNATION).readText() }.getOrNull() != cancelled.incarnation)
            return@whileAccount recovered(dir, slot)
        val through = cancelled.generation
        repaired(context, slot) ?: return@whileAccount null
        // The bound first, kept past the slot (with its numbers): from here no look takes a save at or below it as pending, a
        // job already sending one stops before landing it, and no later save at or below it is kept. Not kept: no cancel.
        readNumbers(context, slot).let { held -> if (through > held.cancelled) writeNumbers(context, slot, held.copy(cancelled = through)) }
        fault?.invoke("cancel")
        // Every save at or below it that never made it into the slot (a staging row's edit, a closed edit) goes too.
        retireStagedThrough(context, slot, through)
        dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot) }.filter { it.generation <= through }.forEach {
            File(dir, it.id + BIN).delete()
            File(dir, it.id + META).delete()
        }
        if ((read(File(dir, RECORD), slot)?.generation ?: Long.MAX_VALUE) <= through) File(dir, RECORD).delete()
        val left = recovered(dir, slot)
        // Nothing left to send and no upload copy in use: the slot goes.
        if (left == null && dir.listFiles().orEmpty().none { it.name.startsWith("sending-") }) clearThrough(dir, through)
        // Its listing no longer shows the cancelled save's size and date.
        notifyFolder(context, cancelled.target)
        left
    } }


    /*
     * Every save of `slot` numbered at or below `through` that never made it into the slot (its staging row and edit, or a
     * closed edit no row names yet) goes: a cancel covers it.
     */
    fun retireStagedThrough(context: Context, slot: String, through: Long) {
        val records = FailedTransfers.of(context)
        val rows = runCatching { records.all() }.getOrDefault(emptyList())
            .filter { it.slot == slot && it.stage != null && retiredBy(it.stage, through) }
        rows.forEach { row -> row.file?.let { discardEdit(File(it)) } }
        if (rows.isNotEmpty()) runCatching { records.forgetWhere { row -> rows.any { it.id == row.id } }; FailedTransfers.changed() }
        File(context.filesDir, EDITS).walkTopDown().filter { it.isFile && it.name.endsWith(".closed") }.toList().forEach { closed ->
            val number = closedNumber(closed) ?: return@forEach
            if (number > through) return@forEach
            val target = runCatching { decodeTarget(sidecarOf(closed).readText()) }.getOrNull() ?: return@forEach
            if (slotOf(target.workspaceId, target.nodeId) == slot) discardEdit(closed)
        }
    }

    /*
     * Whether a cancel took the save of `generation` (a job sending it stops before it lands). Read without the slot's lock
     * (the marker and the numbers each change by one rename), since a sending job asks at every step of its upload.
     */
    fun isCancelled(context: Context, slot: String, generation: Long): Boolean =
        generation <= readNumbers(context, slot).cancelled

    /*
     * The file's folder told that its listing changed (a save kept, cancelled or dismissed): its children's URI by the
     * folder's node id, which every listing of it watches, and "root" too for this account's own top folder.
     */
    fun notifyFolder(context: Context, target: Target) = FilesRoots.foldersChanged(context, listOf(target.folder), target.root)

    /*
     * What a listing (and a family poll's signature) shows of a file another app saved: the size and date of the same
     * newest kept contents a read returns (newestLocked: the pending save, or a retained closed edit). Null when none.
     */
    fun pendingMeta(context: Context, slot: String): Pair<Long, Long>? =
        lockOf(slot).withLock { newestLocked(context, slot)?.let { it.length() to it.lastModified() } }

    /*
     * A failed save's row dismissed (`file`, its generation): only that save goes. While it is still the pending one the
     * slot goes with it (nothing newer to keep); a newer pending save is never touched.
     */
    fun discard(context: Context, slot: String, file: String?) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        val held = recovered(dir, slot) ?: return@withLock
        if (held.id == idOf(file)) {
            clearThrough(dir, held.generation)
            // The same save kept elsewhere too (its staging row and edit, a closed edit of its number) goes with it, so no
            // Retry or reopen brings back what was dismissed.
            val records = FailedTransfers.of(context)
            val same = runCatching { records.all() }.getOrDefault(emptyList()).filter { it.slot == slot && it.stage != null && stagedNumber(it.stage) == held.generation }
            same.forEach { row -> row.file?.let { discardEdit(File(it)) } }
            if (same.isNotEmpty()) runCatching { records.forgetWhere { row -> same.any { it.id == row.id } } }
            closedEditsOf(context, slot).filter { it.first == held.generation }.forEach { discardEdit(it.second) }
            notifyFolder(context, held.target)
        }
    }
}
