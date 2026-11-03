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
     * The slot's pending save, under its lock: the one the record names, its contents there; a complete newer generation
     * a save left unpublished (it died before the record's rename) is published first. Generations neither names go.
     */
    private fun current(dir: File, slot: String): Pending? {
        if (!dir.isDirectory) return null
        // A save a cancel took is never pending again, whatever is left of it on disk.
        // A save at or below the slot's durable bounds (the newest landed, a cancel's) is never pending again, whatever is
        // left of it on disk.
        val through = numbersOf(dir, slot).let { maxOf(it.landed, it.cancelled) }
        val published = read(File(dir, RECORD), slot)?.takeIf { File(dir, it.id + BIN).isFile && it.generation > through }
        val newest = dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty()
            .mapNotNull { read(it, slot) }.filter { File(dir, it.id + BIN).isFile && it.generation > through }.maxByOrNull { it.generation }
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
    fun encodeTarget(t: Target, familyEpoch: Long? = null, number: Long? = null): String = JSONObject().put("number", number ?: JSONObject.NULL).put("workspaceId", t.workspaceId).put("nodeId", t.nodeId).put("name", t.name)
        .put("mime", t.mime ?: JSONObject.NULL).put("folder", t.folder).put("family", t.family ?: JSONObject.NULL)
        .put("familyWorkspace", t.familyWorkspace ?: JSONObject.NULL).put("root", t.root ?: JSONObject.NULL)
        .put("familyEpoch", familyEpoch ?: JSONObject.NULL).toString()

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
        stage(context, accountGeneration, target, edit, reserve(context, slotOf(target.workspaceId, target.nodeId)))

    /* A save older than what its file's slot already holds or landed: never kept (a newer one stands). */
    class Superseded : Exception("A newer save of this file stands.")

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
    fun stage(context: Context, accountGeneration: Long, target: Target, edit: File, number: Long): Pending? = Reservations.whileAccount(accountGeneration) {
        val slot = slotOf(target.workspaceId, target.nodeId)
        lockOf(slot).withLock {
            val dir = dir(context, slot).also { it.mkdirs() }
            // The slot's own id for as long as it exists: what tells a cancel pressed on an earlier slot of the file from this one.
            File(dir, INCARNATION).takeIf { !it.isFile }?.let { file ->
                beforeSlotId?.invoke()
                val incoming = File(dir, "$INCARNATION.incoming").apply { writeText(java.util.UUID.randomUUID().toString()) }
                check(incoming.renameTo(file)) { "The save couldn't be kept." }
            }
            val numbers = readNumbers(context, slot)
            if (number <= maxOf(current(dir, slot)?.generation ?: 0L, numbers.landed, numbers.cancelled)) throw Superseded()
            val id = java.util.UUID.randomUUID().toString()
            val contents = File(dir, "$id$BIN.incoming")
            fault?.invoke("copy")
            java.io.FileOutputStream(contents).use { out ->
                edit.inputStream().use { it.copyTo(out) }
                fault?.invoke("fsync")
                out.fd.sync()
            }
            check(contents.renameTo(File(dir, id + BIN))) { "The save couldn't be kept." }
            val description = JSONObject().put("generation", number).put("id", id).put("workspaceId", target.workspaceId).put("nodeId", target.nodeId)
                .put("name", target.name).put("mime", target.mime ?: JSONObject.NULL).put("folder", target.folder)
                .put("family", target.family ?: JSONObject.NULL).put("familyWorkspace", target.familyWorkspace ?: JSONObject.NULL)
                .put("root", target.root ?: JSONObject.NULL)
            fault?.invoke("json")
            val written = File(dir, "$id$META.incoming")
            java.io.FileOutputStream(written).use { out -> out.write(description.toString().toByteArray()); out.fd.sync() }
            check(written.renameTo(File(dir, id + META))) { "The save couldn't be kept." }
            afterContent?.invoke()
            publish(dir, id)
            current(dir, slot)
            // Kept: only now does the edit go, with its target beside it (a failure to delete it leaves a stray copy, never a
            // lost save: the next reconcile finds its number kept and deletes it).
            runCatching { fault?.invoke("delete"); discardEdit(edit) }
            Pending(slot, number, id, target)
        }
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
    internal fun forgetReservedHere() = reservedHere.clear()

    /* A new edit in `dir`, its target written beside it. */
    fun editIn(dir: File, target: Target): File {
        dir.mkdirs()
        val id = java.util.UUID.randomUUID().toString()
        val incoming = File(dir, "$id.json.incoming").apply { writeText(encodeTarget(target)) }
        check(incoming.renameTo(File(dir, "$id.json"))) { "The edit couldn't be made." }
        return File(dir, id)
    }

    /* An open of this account's own file: its edit under filesDir/edits/personal/<node>. */
    fun personalEdit(context: Context, target: Target): File =
        editIn(File(context.filesDir, "$EDITS/personal/${target.nodeId.lowercase()}"), target)

    /* The file an edit would replace, written beside it as it was made. */
    fun sidecarOf(edit: File): File = File(edit.parentFile, edit.name.substringBefore('.') + ".json")

    /* A closed edit: renamed with its save's number (one rename, no room needed); the edit itself if the rename failed. */
    fun close(edit: File, number: Long): File {
        val closed = File(edit.parentFile, "${edit.name}.$number.closed")
        if (runCatching { fault?.invoke("close") }.isFailure) return edit
        return if (edit.renameTo(closed)) closed else edit
    }

    /* The save number a closed edit was renamed with. */
    fun closedNumber(file: File): Long? = Regex("^[^.]+\\.(\\d+)\\.closed$").find(file.name)?.groupValues?.get(1)?.toLong()

    /* An edit and its target gone: only once its save was kept, dismissed, or let go of. */
    fun discardEdit(edit: File) {
        edit.delete()
        sidecarOf(edit).delete()
    }

    /* Whether the slot already holds or landed a save numbered at or above `number` (a closed edit of it is then moot). */
    fun keptAtOrAbove(context: Context, slot: String, number: Long): Boolean = lockOf(slot).withLock {
        readNumbers(context, slot).let { held -> number <= maxOf(current(dir(context, slot), slot)?.generation ?: 0L, held.landed, held.cancelled) }
    }

    /*
     * Per slot, kept past it (an account file a sign-out wipes): the last number given, the newest landed, every number a
     * cancel took (`cancelled`), and the landing a read hasn't caught up with yet. One file, so the landed bound and its
     * landing marker change together, by one rename: no state on disk says a save landed while a read doesn't know it.
     */
    private data class Numbers(val reserved: Long, val landed: Long, val cancelled: Long = 0L, val landing: Landing? = null)

    private val reservedHere = ConcurrentHashMap<String, Long>()

    private fun numbersFile(context: Context, slot: String) = File(context.filesDir, "$NUMBERS/$slot")

    private fun readNumbers(context: Context, slot: String): Numbers = readNumbersAt(numbersFile(context, slot))

    /* The numbers of the slot whose folder is `dir` (queue/<slot> under filesDir): the one place the durable bounds are read. */
    private fun numbersOf(dir: File, slot: String): Numbers = readNumbersAt(File(dir.parentFile?.parentFile, "$NUMBERS/$slot"))

    private fun readNumbersAt(file: File): Numbers = runCatching {
        val lines = file.readText().split("\n")
        val parts = lines[0].trim().split(" ")
        val landing = lines.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { Landing(it, lines.getOrNull(2)?.ifEmpty { null }) }
        Numbers(parts[0].toLong(), parts[1].toLong(), parts.getOrNull(2)?.toLong() ?: 0L, landing)
    }.getOrDefault(Numbers(0L, 0L))

    /* Written whole and synced, then renamed into place (its folder synced too where the platform lets it): old or new, never half. */
    private fun writeNumbers(context: Context, slot: String, numbers: Numbers) {
        fault?.invoke("numbers")
        val file = numbersFile(context, slot).also { it.parentFile?.mkdirs() }
        val incoming = File(file.parentFile, "$slot.incoming")
        val text = "${numbers.reserved} ${numbers.landed} ${numbers.cancelled}" + (numbers.landing?.let { "\n${it.id}\n${it.version ?: ""}" } ?: "")
        java.io.FileOutputStream(incoming).use { out -> out.write(text.toByteArray()); out.fd.sync() }
        check(incoming.renameTo(file)) { "The save's number couldn't be kept." }
        runCatching {
            val fd = android.system.Os.open(file.parentFile!!.path, android.system.OsConstants.O_RDONLY, 0)
            try { android.system.Os.fsync(fd) } finally { android.system.Os.close(fd) }
        }
    }

    /*
     * A save's order, given as the app closes the file and before anything is kept: above every number the file's saves
     * had, pending, landed, cancelled or given before (kept on disk past the slot, and in memory, so a disk that refuses
     * the write still gives an increasing number). Only reads: nothing is published or tidied here, and it never throws.
     */
    fun reserve(context: Context, slot: String): Long = lockOf(slot).withLock {
        val held = readNumbers(context, slot)
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
        runCatching { writeNumbers(context, slot, held.copy(reserved = number)) }
        number
    }

    /*
     * The newest contents another app kept of the file, by save number: its pending save, or an edit whose save couldn't be
     * kept in the slot (a failed row holds it). What every open that keeps the contents starts from, and what a read gets.
     * A copy in `dest`; false when there is neither.
     */
    fun copyNewestTo(context: Context, slot: String, dest: File): Boolean {
        // The closed edits on disk, row or not (a row that couldn't be written leaves only the edit), and any row's edit; never
        // one at or below the newest landed save or a cancel's bound (a newer save stands, or the save was cancelled).
        // All of it under the slot's lock a landing and a cancel take, so the edit chosen is never deleted before it is copied.
        return lockOf(slot).withLock {
            val settled = readNumbers(context, slot).let { maxOf(it.landed, it.cancelled) }
            val staged = (closedEditsOf(context, slot) + runCatching { FailedTransfers.of(context).all() }.getOrDefault(emptyList())
                .filter { it.slot == slot && it.stage != null }
                .mapNotNull { row -> stagedNumber(row.stage!!)?.let { it to File(row.file ?: return@mapNotNull null) } })
                .filter { it.first > settled && it.second.isFile }.maxByOrNull { it.first }
            afterNewestChosen?.invoke()
            val dir = dir(context, slot)
            val pending = current(dir, slot)
            val source = when {
                staged != null && (pending == null || staged.first > pending.generation) -> staged.second
                pending != null -> File(dir, pending.id + BIN)
                else -> return@withLock false
            }
            dest.parentFile?.mkdirs()
            source.copyTo(dest, overwrite = true)
            true
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
        try {
            File(dir, pending.id + BIN).copyTo(sending, overwrite = true)
        } catch (error: Exception) {
            // Nothing half-copied is left: the save itself stays as it was.
            sending.deleteRecursively()
            throw error
        }
        pending to sending
    }

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
            sending.renameTo(readCopy) || runCatching { sending.copyTo(readCopy, overwrite = true); true }.getOrDefault(false)
        } else false
        fault?.invoke("landed-copy")
        // 2. The landing marker and the newest number landed, in one write (one rename): from here a read refreshes or serves
        //    the landed bytes, and a save numbered at or below it (a staging retry) is never kept again. Refused, nothing
        //    below runs (the caller's job tries again).
        readNumbers(context, slot).let { held ->
            writeNumbers(context, slot, held.copy(landed = maxOf(held.landed, generation), landing = Landing(java.util.UUID.randomUUID().toString(), if (kept) version else null)))
        }
        fault?.invoke("landed-mark")
        // 3. Every save at or below it that never made it into the slot goes now, found on disk (a closed edit no row names
        //    too); a death before this is finished by the next reconcile (retireSettled).
        if (generation > 0L) retireStagedThrough(context, slot, generation)
        fault?.invoke("landed-retire")
        // 4. The slot cleared of it.
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
     * A file's save landed from its job's own vault: the reader's vault may still hold the version before. Kept on disk
     * with the slot's numbers (filesDir/writeback-numbers/<slot>, with the landed bound) until a read caught up with the server: a
     * landing id of its own (so a read only clears the landing it refreshed for) and the version the save became, when
     * its bytes were kept as that version's read copy. A read that can't reach the server serves those bytes, or fails;
     * never the version before.
     */
    data class Landing(val id: String, val version: String?)

    /* Where an earlier build kept landings apart from the numbers: nothing reads it now; a sign-out still wipes it. */
    const val LANDINGS = "writeback-landings"

    /* Tests: a landing of the file noted, as `landed` notes one. */
    internal fun noteLanding(context: Context, slot: String, version: String?) = lockOf(slot).withLock {
        writeNumbers(context, slot, readNumbers(context, slot).copy(landing = Landing(java.util.UUID.randomUUID().toString(), version)))
    }

    /* The file's latest landing a read hasn't caught up with, if any (read without the lock: the file changes by one rename). */
    fun landing(context: Context, slot: String): Landing? = readNumbers(context, slot).landing

    /* A read caught up with the server after landing `seen`: only that landing goes, never one that came meanwhile. */
    fun caughtUp(context: Context, slot: String, seen: String) = lockOf(slot).withLock {
        val held = readNumbers(context, slot)
        if (held.landing?.id == seen) runCatching { writeNumbers(context, slot, held.copy(landing = null)) }
    }

    /*
     * The slot's saves at or below its durable bounds (landed, cancelled) that never made it into it, gone: what a landing
     * or a cancel that died after its bound left (the next reconcile runs this), under the slot's lock.
     */
    fun retireSettled(context: Context, slot: String) = lockOf(slot).withLock {
        val through = readNumbers(context, slot).let { maxOf(it.landed, it.cancelled) }
        if (through > 0L) retireStagedThrough(context, slot, through)
    }

    /*
     * An old slot the sweep found with nothing to send and no job: deleted only if, looked at again under its lock, it still
     * holds no save (one published meanwhile stays).
     */
    fun removeIfEmpty(context: Context, slot: String) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        if (current(dir, slot) == null) dir.deleteRecursively()
    }

    /*
     * A staging row's save `number` dismissed: whatever of it reached the slot (a generation written whose record couldn't be
     * published) goes too, under the slot's lock, so no later look publishes it; any other save is untouched.
     */
    fun dismissSave(context: Context, slot: String, number: Long) = lockOf(slot).withLock {
        val dir = dir(context, slot)
        fault?.invoke("dismiss")
        if (!dir.isDirectory) return@withLock
        dir.listFiles { f -> f.name.endsWith(META) && f.name != RECORD }.orEmpty().mapNotNull { read(it, slot) }.filter { it.generation == number }.forEach {
            File(dir, it.id + BIN).delete()
            File(dir, it.id + META).delete()
        }
        if (read(File(dir, RECORD), slot)?.generation == number) File(dir, RECORD).delete()
        current(dir, slot)
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
     * pending. Nothing when the slot it was pressed on is gone. The save left, if any.
     */
    fun cancelThrough(context: Context, slot: String, cancelled: Captured?): Pending? = lockOf(slot).withLock {
        val dir = dir(context, slot)
        // The slot Cancel was pressed on, still: one made since the earlier one went counts afresh, and none of it is taken.
        if (cancelled == null || !dir.isDirectory || runCatching { File(dir, INCARNATION).readText() }.getOrNull() != cancelled.incarnation)
            return@withLock current(dir, slot)
        val through = cancelled.generation
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
        val left = current(dir, slot)
        // Nothing left to send and no upload copy in use: the slot goes.
        if (left == null && dir.listFiles().orEmpty().none { it.name.startsWith("sending-") }) dir.deleteRecursively()
        // Its listing no longer shows the cancelled save's size and date.
        notifyFolder(context, cancelled.target)
        left
    }


    /*
     * Every save of `slot` numbered at or below `through` that never made it into the slot (its staging row and edit, or a
     * closed edit no row names yet) goes: a cancel covers it.
     */
    fun retireStagedThrough(context: Context, slot: String, through: Long) {
        val records = FailedTransfers.of(context)
        val rows = runCatching { records.all() }.getOrDefault(emptyList())
            .filter { it.slot == slot && it.stage != null && (stagedNumber(it.stage) ?: 0L) <= through }
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
        if (held.id == idOf(file)) {
            clear(dir)
            notifyFolder(context, held.target)
        }
    }
}
