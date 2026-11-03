package com.hushos.app.data

import com.hushos.core.ChainRoute
import com.hushos.core.CoreException
import com.hushos.core.GrantsCall
import com.hushos.core.Handover
import com.hushos.core.MembersRole
import com.hushos.core.OutboxCall
import com.hushos.core.OutboxHold
import com.hushos.core.OutboxStep
import com.hushos.core.OwedGrant
import com.hushos.core.RosterCall
import com.hushos.core.SignerHistory
import com.hushos.core.base64urlDecode
import com.hushos.core.outboxStep
import org.json.JSONObject
import java.io.File

/*
 * A manager's calls on a phone (docs/groups-mobile-plan.md, Android 5a; the web's members.tsx, family-trust.ts and
 * lib/groups/outbox.ts): Invite someone, the invitations still open, who is waiting to join, Let them in and Not now.
 * Every roster call is the core's (`admit_body`): signed once over the family's committed chain, kept in the outbox
 * before the first send, and sent again byte for byte until the server gives a definite answer (`outbox_step`). After a
 * lock, a kill or a relaunch the kept entry is read back by the core (`outbox_open`), which answers whether it is sent
 * as it is, held, or already landed or overtaken; nothing is signed again for it.
 */

/*
 * The outbox (the web's `outbox` store): each roster call's sealed entry, kept before it is first sent and deleted on a
 * definite answer. In `noBackupFilesDir/groups/outbox/`, so every wipe of the account's family records takes it too
 * (FamilyRecords.deleteAll). One file per entry, written beside and moved over; under the records' lock and session.
 */
class FamilyOutbox(private val folder: File, private val open: () -> Boolean = { true }) {
    data class Kept(val outboxId: String, val entry: String)

    private fun file(userId: String, groupId: String, outboxId: String): File? {
        val ids = listOf(userId.lowercase(), groupId.lowercase(), outboxId.lowercase())
        if (ids.any { !FamilyRecords.valid(it) }) return null
        return File(folder, "${ids[0]}_${ids[1]}_${ids[2]}.call")
    }

    /* Kept before the first send: a write that may not be on disk throws, and nothing is sent. */
    fun put(userId: String, groupId: String, outboxId: String, entry: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) throw OutboxUnsaved()
        val target = file(userId, groupId, outboxId) ?: throw OutboxUnsaved()
        try {
            folder.mkdirs()
            val next = File(target.path + ".next")
            next.writeText(entry)
            if (!next.renameTo(target)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw OutboxUnsaved()
        }
    }

    /*
     * Dropped after a definite answer. A file that stays throws: left, it would be read again at the next open (judged
     * by the core then, never signed again), but the answer that dropped it isn't to be taken as done. Its notes go with it.
     */
    fun delete(userId: String, groupId: String, outboxId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        val target = file(userId, groupId, outboxId) ?: return@synchronized
        if (!target.delete() && target.exists()) throw OutboxUnsaved()
        File(target.path.removeSuffix(".call") + ".cleared").delete()
        File(target.path.removeSuffix(".call") + ".recheck").delete()
    }

    /*
     * Documents the core carried on empty in an entry that hasn't been read again yet: written before the entry, removed only
     * once the read-again finished and its clearing notes are written (`noteCleared`). While it stands the entry is never
     * sent (sendKept finishes the recheck first), whatever process or open finds it.
     */
    fun markRecheck(userId: String, groupId: String, outboxId: String, replaced: Collection<com.hushos.core.ReplacedDocument>) = synchronized(FamilyCopies.LOCK) {
        if (replaced.isEmpty()) return@synchronized
        if (!open()) throw OutboxUnsaved()
        val target = file(userId, groupId, outboxId)?.let { File(it.path.removeSuffix(".call") + ".recheck") } ?: throw OutboxUnsaved()
        try {
            folder.mkdirs()
            val next = File(target.path + ".next")
            next.writeText(replaced.joinToString("\n") { it.workspaceId.lowercase() + " " + it.kind })
            if (!next.renameTo(target)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw OutboxUnsaved()
        }
    }

    /* The documents an entry still has to read again; none when it doesn't. One that can't be read throws, never reads as none. */
    fun recheck(userId: String, groupId: String, outboxId: String): List<com.hushos.core.ReplacedDocument> {
        val target = file(userId, groupId, outboxId)?.let { File(it.path.removeSuffix(".call") + ".recheck") } ?: return emptyList()
        if (!target.exists()) return emptyList()
        val lines = try { target.readLines().filter { it.isNotBlank() } } catch (_: Exception) { throw OutboxUnreadable() }
        return lines.map { line ->
            val parts = line.split(" ").takeIf { it.size == 2 } ?: throw OutboxUnreadable()
            com.hushos.core.ReplacedDocument(parts[0], parts[1])
        }
    }

    fun clearRecheck(userId: String, groupId: String, outboxId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        val target = file(userId, groupId, outboxId)?.let { File(it.path.removeSuffix(".call") + ".recheck") } ?: return@synchronized
        if (!target.delete() && target.exists()) throw OutboxUnsaved()
    }

    /*
     * A removal the person confirmed and that hasn't ended: whom, the lapsed plans they confirmed end (ids), whether they asked
     * to stop them managing first, and their first name. Kept before anything of it changes, and dropped only at a definite
     * end, so a removal stopped part way (a departure to mark left first, a demotion with no answer, a process killed) goes
     * on at the next open (resumeOutbox).
     */
    data class Removal(val userId: String, val first: String, val endsLapsed: List<String>, val demote: Boolean)

    private fun removalsFile(userId: String, groupId: String): File? {
        val ids = listOf(userId.lowercase(), groupId.lowercase())
        if (ids.any { !FamilyRecords.valid(it) }) return null
        return File(folder, "${ids[0]}_${ids[1]}.removals")
    }

    /* The removals under way, oldest first; a file that can't be read throws (never read as none: a promise would be lost). */
    fun removals(userId: String, groupId: String): List<Removal> {
        val file = removalsFile(userId, groupId) ?: return emptyList()
        if (!file.exists()) return emptyList()
        return try {
            val list = org.json.JSONArray(file.readText())
            (0 until list.length()).map { i ->
                val row = list.getJSONObject(i)
                val plans = row.getJSONArray("endsLapsed")
                Removal(row.getString("userId").takeIf(FamilyRecords::valid) ?: throw OutboxUnreadable(), row.getString("first"),
                    (0 until plans.length()).map(plans::getString), row.getBoolean("demote"))
            }
        } catch (unreadable: OutboxUnreadable) {
            throw unreadable
        } catch (_: Exception) {
            throw OutboxUnreadable()
        }
    }

    private fun writeRemovals(userId: String, groupId: String, list: List<Removal>) {
        if (!open()) throw OutboxUnsaved()
        val file = removalsFile(userId, groupId) ?: throw OutboxUnsaved()
        try {
            if (list.isEmpty()) {
                if (!file.delete() && file.exists()) throw java.io.IOException("not deleted")
                return
            }
            folder.mkdirs()
            val json = org.json.JSONArray(list.map {
                JSONObject().put("userId", it.userId.lowercase()).put("first", it.first).put("endsLapsed", org.json.JSONArray(it.endsLapsed)).put("demote", it.demote)
            })
            val next = File(file.path + ".next")
            next.writeText(json.toString())
            if (!next.renameTo(file)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw OutboxUnsaved()
        }
    }

    fun keepRemoval(userId: String, groupId: String, removal: Removal) = synchronized(FamilyCopies.LOCK) {
        writeRemovals(userId, groupId, removals(userId, groupId).filter { !it.userId.equals(removal.userId, ignoreCase = true) } + removal)
    }

    fun dropRemoval(userId: String, groupId: String, target: String) = synchronized(FamilyCopies.LOCK) {
        val now = removals(userId, groupId)
        if (now.none { it.userId.equals(target, ignoreCase = true) }) return@synchronized
        writeRemovals(userId, groupId, now.filter { !it.userId.equals(target, ignoreCase = true) })
    }

    /*
     * The kinds of workspace document a kept rotating call carries on empty (they didn't open, even read again), kept beside
     * the entry (the web's entry notices): said once the call lands, whichever open or process sends it.
     */
    fun noteCleared(userId: String, groupId: String, outboxId: String, kinds: Collection<String>) = synchronized(FamilyCopies.LOCK) {
        if (kinds.isEmpty()) return@synchronized
        if (!open()) throw OutboxUnsaved()
        val target = file(userId, groupId, outboxId)?.let { File(it.path.removeSuffix(".call") + ".cleared") } ?: throw OutboxUnsaved()
        try {
            val all = (cleared(userId, groupId, outboxId) + kinds).distinct().sorted()
            val next = File(target.path + ".next")
            next.writeText(all.joinToString("\n"))
            if (!next.renameTo(target)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw OutboxUnsaved()
        }
    }

    /* What `noteCleared` kept for an entry; none when nothing was. */
    fun cleared(userId: String, groupId: String, outboxId: String): List<String> {
        val target = file(userId, groupId, outboxId)?.let { File(it.path.removeSuffix(".call") + ".cleared") } ?: return emptyList()
        if (!target.exists()) return emptyList()
        return try { target.readLines().filter { it.isNotBlank() } } catch (_: Exception) { emptyList() }
    }

    /* Every entry of this account's for the family, and its handover: a not-member wipe takes them with the family (the web's forgetGroup). */
    fun deleteGroup(userId: String, groupId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        for (file in entries(userId, groupId)) {
            if (!file.delete() && file.exists()) throw OutboxUnsaved()
            File(file.path.removeSuffix(".call") + ".cleared").delete()
            File(file.path.removeSuffix(".call") + ".recheck").delete()
        }
        clearHandover(userId, groupId)
        removalsFile(userId, groupId)?.let { if (!it.delete() && it.exists()) throw OutboxUnsaved() }
    }

    /*
     * The organizer handover under way, by whom it goes to: kept before its first call is signed, so a handover the app
     * was killed in the middle of (billing given, not yet let go of) is finished at the next open. Deleted once it ends.
     */
    private fun handoverFile(userId: String, groupId: String): File? {
        val ids = listOf(userId.lowercase(), groupId.lowercase())
        if (ids.any { !FamilyRecords.valid(it) }) return null
        return File(folder, "${ids[0]}_${ids[1]}.handover")
    }

    /* The handover's record: whom it goes to, and whether its first call (billing to them) was staged yet. */
    data class KeptHandover(val to: String, val staged: Boolean)

    fun markHandover(userId: String, groupId: String, to: String, staged: Boolean = false) = synchronized(FamilyCopies.LOCK) {
        if (!open() || !FamilyRecords.valid(to.lowercase())) throw OutboxUnsaved()
        val target = handoverFile(userId, groupId) ?: throw OutboxUnsaved()
        try {
            folder.mkdirs()
            val next = File(target.path + ".next")
            next.writeText(to.lowercase() + if (staged) "\nstaged" else "")
            if (!next.renameTo(target)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw OutboxUnsaved()
        }
    }

    /* A handover under way; none when none is. One that can't be read throws, never reads as none. */
    fun handover(userId: String, groupId: String): KeptHandover? {
        val file = handoverFile(userId, groupId) ?: return null
        if (!file.exists()) return null
        val lines = try { file.readText().trim().lines() } catch (_: Exception) { throw OutboxUnreadable() }
        val to = lines.firstOrNull()?.takeIf(FamilyRecords::valid) ?: throw OutboxUnreadable()
        return KeptHandover(to, lines.getOrNull(1) == "staged")
    }

    fun clearHandover(userId: String, groupId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        val file = handoverFile(userId, groupId) ?: return@synchronized
        if (!file.delete() && file.exists()) throw OutboxUnsaved()
    }

    /*
     * This account's entries for the family, oldest first. A folder or an entry that can't be read throws (never an
     * empty or a partial list: a kept call missed here would be signed again, or skipped): only one read whole and then
     * refused by the core (`outbox_open`'s Sealed) is lost.
     */
    fun list(userId: String, groupId: String): List<Kept> {
        val prefix = "${userId.lowercase()}_${groupId.lowercase()}_"
        return entries(userId, groupId).sortedBy { it.lastModified() }.map { file ->
            val id = file.name.removePrefix(prefix).removeSuffix(".call")
            val entry = try { file.readText() } catch (_: Exception) { throw OutboxUnreadable() }
            Kept(id, entry)
        }
    }

    /* The entry files named for this account and family; a folder that exists but can't be listed throws. */
    private fun entries(userId: String, groupId: String): List<File> {
        val prefix = "${userId.lowercase()}_${groupId.lowercase()}_"
        if (!folder.exists()) return emptyList()
        val files = folder.listFiles() ?: throw OutboxUnreadable()
        return files.filter { it.name.startsWith(prefix) && it.name.endsWith(".call") && FamilyRecords.valid(it.name.removePrefix(prefix).removeSuffix(".call")) }
    }

    companion object {
        fun of(context: android.content.Context, open: () -> Boolean = { true }) =
            FamilyOutbox(File(File(context.noBackupFilesDir, FamilyRecords.FOLDER), "outbox"), open)
    }
}

/* The outbox couldn't be read, or written, on this device: nothing is signed or sent, and the screens say so. */
class OutboxUnreadable : Refused("Nothing was changed", GuardWords.UNREADABLE)
class OutboxUnsaved : Refused("Nothing was changed", GuardWords.UNSAVED)

/* How a roster call ended, as the screens say it. */
sealed interface CallEnd {
    /* The server took it, and the family was synced. */
    data object Landed : CallEnd
    /* No definite answer yet: kept on this phone, sent again at the next open. */
    data class Pending(val reason: String) : CallEnd
    /*
     * Refused, in the families' words; the entry is gone. `code` and `data` are the server's, for a caller that acts on one
     * (a removal meeting `left-due`, `members-changed` or `ends-lapsed`); none for a refusal made here.
     */
    data class Refused(val words: String, val code: String? = null, val data: JSONObject? = null) : CallEnd
    /* Another roster won at that version: dropped; build it again over the winner. */
    data object Stale : CallEnd
    /* Kept, never sent: an admission sealed to other keys than this account's pin of the person holds now. */
    data object OtherKeys : CallEnd
    /* The server said this account is not in the family: let go of (FamilySync.removedNow, published to the screens). */
    data object Wiped : CallEnd
    /* Kept for someone other than the person asked about: left as it is, nothing sent. */
    data object Other : CallEnd
}

/* What Let them in came to. */
sealed interface LetIn {
    data object Landed : LetIn
    data class Pending(val reason: String) : LetIn
    data class Refused(val words: String) : LetIn
    /* Their account changed since this phone pinned them: the changed-account notice, then let them in. */
    data class Changed(val change: AccountChange) : LetIn
    /* An earlier Let them in for them is kept for their keys before a change: dropped only on the person's say. */
    data object KeptOther : LetIn
    data object Wiped : LetIn
}

internal val FamilySync.outbox: FamilyOutbox get() = FamilyOutbox.of(vault.context) { !vault.closed }

/*
 * The words a refusal of a roster call says: the web's refusalCopy for every code route 17 answers (its chainAnswer, the
 * checks before it, the route's 426, 429 and 413), so none falls through to a retry that can't help. Where the web says
 * "Reload and try again", a phone says "Try again" (it has no page to reload), as it does for `unsupported`.
 */
internal fun callWords(answer: CallAnswer, first: String?, family: String = "this family"): String = when (answer.code) {
    "invalid" -> "Couldn’t save that change. Try again."
    "succession-due" -> "A manager of $family needs to finish an earlier change first. Try again."
    "left-due" -> "Someone left the family. A manager needs to finish that before anyone can join or roles change."
    "members-changed", "stale" -> "$family changed while you were working on it. Try again."
    "busy" -> "Another change to this plan is in progress. Try again in a moment."
    // The web's seats words. A phone never buys a place (billing is read only there): the server
    // refuses one that would need a purchase as `full`, said as the web's plain "no free places".
    "seats" -> when (answer.data?.optString("reason")) {
        "no-plan" -> "Choose a plan for $family before letting anyone in."
        "payer" -> "Every place in the plan for $family is taken. Ask the person who pays for it to add a place."
        "cap" -> "The plan for $family allows no more members."
        else -> "Every place in $family is taken."
    }
    "no-plan" -> "Choose a plan for $family first. Until it has one, nobody can be invited and no family folders can be made."
    // Let them in: the newcomer's other family is never named to this one.
    "in-family" -> if (answer.data?.optString("reason") == "newcomer") "They’ve joined another family since they accepted. They can join yours once they leave it."
        else "You’re in a family already. Leave it before you create another."
    // No figure: managers learn only that the newcomer's files are more than what's free. Without the web's
    // "or move to a bigger plan": a phone's billing is read only (owner, 2026-11-03).
    "pool-full" -> "Their files don’t fit in the family’s free space. Free up space, then let them in."
    "unsupported" -> "Update HushOS to do this."
    "forbidden" -> "Only someone who manages the family can do that."
    "not-member" -> FamilyWords.NOT_IN_FAMILY
    "not-pending" -> first?.let { "$it isn’t waiting to join any more." } ?: "They aren’t waiting to join any more."
    "held" -> "Another manager paused your changes in this family for now."
    "rotating", "epoch-stale", "root-moved", "document-stale" -> "A family folder was changing at the same time. Try again in a moment."
    "root-mid-rotation" -> "A family folder is in the middle of a key change this server can’t account for. Contact the server’s operator."
    "not-rotating", "area-moved" -> "A family folder changed meanwhile. Try again."
    "no-seal" -> "Another manager needs to open the family before you can change it. Try again later."
    "area-limit" -> answer.data?.takeIf { it.has("limit") }?.optInt("limit")?.let { "A family can have at most $it shared folders on this server." }
        ?: "This family has as many shared folders as this server allows."
    "grants-due" -> GRANTS_DUE
    "already-member" -> "That person is already in the family."
    "too-large" -> "That change is too large for this server."
    "rate-limited" -> "That’s been tried too often. Wait a little, then try again."
    "unavailable" -> "HushOS couldn’t save that just now. Try again in a moment."
    // A code this app doesn't know (a newer server): the web's own fallback.
    null -> if (answer.status == 0) GroupsApiError.NO_ANSWER else "HushOS couldn’t do that just now. Try again in a moment."
    else -> "Couldn’t save that change. Try again."
}

/*
 * One kept entry sent until a definite answer (the web's sendLocked), inside the family's turn: read back by the core
 * before every attempt (held while this account's pin of an admission's person no longer holds the keys it was staged
 * over; dropped when the committed chain already holds it or moved past it), then its very bytes sent. Unknown answers
 * are sent again a few times, then kept for the next open; grants a call is owed are posted first and the same bytes
 * sent again; `stale`, membership moves and refusals drop it; not-member lets go of the family as every removal does.
 * `only`: a call on that route (an admission of that person, a change of their roles), else `Other` and nothing is
 * touched. `names` gives a person's first name. `told` is handed every outcome that drops the entry, with the call's
 * route (none for one that couldn't be read), before the entry is deleted: what a call came to is never lost with its
 * entry (a page left meanwhile, a later entry that throws).
 */
internal fun FamilySync.sendKept(summary: GroupSummary, kept: FamilyOutbox.Kept, only: ChainRoute? = null, names: (String) -> String? = { null },
    told: (ChainRoute?, CallEnd) -> Unit = { _, _ -> }): CallEnd {
    val groupId = summary.id
    var resends = 0
    var fixes = 0
    var on: ChainRoute? = null
    // A rotating call rebuilt (its folders gathered again) is kept over the old entry, under the same outbox id.
    var current = kept
    fun finish(end: CallEnd): CallEnd {
        told(on, end)
        // Documents a landed rotation carried on empty are said (FamilySync.takeCleared) before its notes go with the entry.
        if (end == CallEnd.Landed) outbox.cleared(userId, groupId, current.outboxId).forEach { clearedSaid.add(clearedWords(it)) }
        outbox.delete(userId, groupId, current.outboxId)
        return end
    }
    while (true) {
        // The settings read afresh first: the core judges an admission against this account's pin of them now. A read
        // that fails sends nothing (the ledger still holds the last settings, whose pin another device may have
        // replaced): no answer keeps the entry for the next try, anything else is passed on, the entry kept.
        try {
            vault.familyPin(groupId)
        } catch (failed: Exception) {
            if (failed is NotAuthenticated || !settingsUnavailable(failed)) throw failed
            return CallEnd.Pending(GroupsApiError.NO_ANSWER)
        }
        val read = try {
            ledger.outboxOpen(groupId, current.outboxId, userId, current.entry)
        } catch (sealed: CoreException.Sealed) {
            // Not an entry of this account's any more (sealed before a master-key change): never sent, deleted, said lost.
            return finish(CallEnd.Refused("A change to ${summary.name} hadn’t reached the server and couldn’t be opened on this device. Make it again."))
        }
        on = read.route()
        if (only != null && !sameRoute(read.route(), only)) return CallEnd.Other
        val first = personOf(read.route())?.let(names)
        // Documents still to be read again: done first (read, rebuilt, noted), and the entry read again before anything is sent.
        if (read is OutboxCall.Send) {
            val replaced = outbox.recheck(userId, groupId, current.outboxId)
            if (replaced.isNotEmpty()) {
                current = readAgain(groupId, current, replaced)
                continue
            }
        }
        val (route, body) = when (read) {
            is OutboxCall.Send -> read.route to read.body
            // AwaitingCheck and Committed are the web's own entries (an earlier web version's held-back admission, a
            // creation); a phone's outbox holds only what it staged, so only OtherKeys is met here.
            is OutboxCall.Hold -> return if (read.reason == OutboxHold.OTHER_KEYS) CallEnd.OtherKeys else CallEnd.Pending("Kept on this device.")
            is OutboxCall.Landed -> { finish(CallEnd.Landed); syncRevised(summary); return CallEnd.Landed }
            is OutboxCall.Superseded -> return finish(CallEnd.Stale)
        }
        val answer = api.sendCall(groupId, route, body)
        when (outboxStep(answer.status.toUShort(), answer.code)) {
            OutboxStep.LANDED -> {
                finish(CallEnd.Landed)
                syncRevised(summary)
                return CallEnd.Landed
            }
            OutboxStep.RESEND -> {
                // The same bytes again, a few times now, then at the next open.
                if (++resends >= RESENDS) return CallEnd.Pending(callWords(answer, first, summary.name))
                Thread.sleep(RESEND_DELAY_MS * resends)
            }
            OutboxStep.REBUILD -> {
                // A folder the call rotates moved (a walk running, an epoch overtaken, its top folder or a document changed):
                // gathered again and the call's rotations made again under the same keys and roster, kept, then sent.
                if (++fixes > 3) return CallEnd.Pending(callWords(answer, first, summary.name))
                when (val rebuilt = rebuildKept(summary, current, route, body, answer)) {
                    is Rebuilt.Kept -> current = rebuilt.kept
                    is Rebuilt.Unsent -> return CallEnd.Pending(rebuilt.words)
                    Rebuilt.Wiped -> return CallEnd.Wiped
                }
            }
            OutboxStep.SEND_GRANTS -> {
                if (++fixes > 3) return CallEnd.Pending(GRANTS_DUE)
                when (val granted = sendGrants(summary, answer.data)) {
                    Granted.Sent -> {}
                    is Granted.Unsent -> return CallEnd.Pending(granted.words)
                    Granted.Wiped -> return CallEnd.Wiped
                }
            }
            OutboxStep.STALE -> {
                finish(CallEnd.Stale)
                syncRevised(summary)
                return CallEnd.Stale
            }
            OutboxStep.MEMBERSHIP_MOVED -> {
                val end = finish(CallEnd.Refused(callWords(answer, first, summary.name), answer.code, answer.data))
                syncRevised(summary)
                return end
            }
            OutboxStep.REFUSED -> {
                val end = finish(CallEnd.Refused(callWords(answer, first, summary.name), answer.code, answer.data))
                if (answer.code == "forbidden") syncRevised(summary)
                return end
            }
            OutboxStep.WIPED -> {
                // As every not-member: two-phase, its outcome (finished, or refused with a guard not stored) published.
                removedNow(groupId)
                return CallEnd.Wiped
            }
        }
    }
}

/* A settings read that may pass next time: no answer, or the server's for now (a timeout, throttling, a server error). */
private fun settingsUnavailable(error: Exception): Boolean = FamilySync.transient(error) ||
    (error is AuthFailure && (error.status == 408 || error.status == 429 || error.status >= 500))

/* Whom a call is about: the person let in, whose roles change, or who is removed. */
internal fun personOf(route: ChainRoute?): String? = when (route) {
    is ChainRoute.Admit -> route.userId
    is ChainRoute.Member -> route.userId
    is ChainRoute.Remove -> route.userId
    else -> null
}

/*
 * The same call's route: an admission, a role change or a removal of the same person, a key replacement or deletion of the
 * same folder, or marking the departed left.
 */
private fun sameRoute(a: ChainRoute, b: ChainRoute): Boolean = when {
    a is ChainRoute.Admit && b is ChainRoute.Admit -> a.userId.equals(b.userId, ignoreCase = true)
    a is ChainRoute.Member && b is ChainRoute.Member -> a.userId.equals(b.userId, ignoreCase = true)
    a is ChainRoute.Remove && b is ChainRoute.Remove -> a.userId.equals(b.userId, ignoreCase = true)
    a is ChainRoute.Rotation && b is ChainRoute.Rotation -> a.workspaceId.equals(b.workspaceId, ignoreCase = true)
    a is ChainRoute.Delete && b is ChainRoute.Delete -> a.workspaceId.equals(b.workspaceId, ignoreCase = true)
    a is ChainRoute.Rosters && b is ChainRoute.Rosters -> true
    else -> false
}

internal fun OutboxCall.route(): ChainRoute = when (this) {
    is OutboxCall.Send -> route
    is OutboxCall.Hold -> route
    is OutboxCall.Landed -> route
    is OutboxCall.Superseded -> route
}

/* The web's grants-due words: a member still lacks a folder's keys, and the call waits for them. */
private const val GRANTS_DUE = "Someone in the family is still missing a folder’s keys. Try again in a moment."

private sealed interface Granted {
    data object Sent : Granted
    /* Not all posted: the call stays kept, with why. */
    data class Unsent(val words: String) : Granted
    /* Route 22 answered not-member: let go of as every removal (removedNow). */
    data object Wiped : Granted
}

/*
 * Route 22's grants a call was told it owes (`grants-due`'s `missing`), sealed by the core and posted in order. Every
 * owed grant or none: a row the answer doesn't name whole, or a member whose key route 6 doesn't serve, posts nothing.
 */
private fun FamilySync.sendGrants(summary: GroupSummary, data: JSONObject?): Granted {
    val groupId = summary.id
    val missing = data?.optJSONArray("missing") ?: return Granted.Unsent(GRANTS_DUE)
    val rows = (0 until missing.length()).map { missing.optJSONObject(it) ?: return Granted.Unsent(GRANTS_DUE) }
    if (rows.isEmpty()) return Granted.Unsent(GRANTS_DUE)
    val kems = fetchIdentities(groupId)
    val owed = rows.map { row ->
        val user = row.optString("userId").lowercase()
        val workspace = row.optString("workspaceId")
        if (user.isEmpty() || workspace.isEmpty()) return Granted.Unsent(GRANTS_DUE)
        val kem = kems[user]?.identity?.kemPublicKey ?: return Granted.Unsent("HushOS couldn’t load everyone’s keys. Try again.")
        OwedGrant(workspace, user, kem)
    }
    repeat(2) { round ->
        when (val calls = ledger.grantsBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, owed)) {
            is GrantsCall.Grants -> {
                for (request in calls.requests) {
                    val answer = api.postGrants(groupId, request.workspaceId, request.body)
                    if (answer.status in 200..299) continue
                    if (answer.status == 404 && answer.code == "not-member") {
                        removedNow(groupId)
                        return Granted.Wiped
                    }
                    return Granted.Unsent(callWords(answer, null, summary.name))
                }
                return Granted.Sent
            }
            // The chain or a folder isn't open here: synced once, then asked again.
            GrantsCall.SyncFirst, GrantsCall.OpenFoldersFirst -> if (round == 0) syncRevised(summary)
        }
    }
    return Granted.Unsent(GRANTS_DUE)
}

/*
 * Whatever the outbox holds for the family, sent again as it is (the web's resumeOutbox), at every open of a family this
 * account manages: a send that got no answer before a lock, a kill or a relaunch finishes here, never signed again.
 * Each entry's end, by its outbox id. Then a handover the app stopped in the middle of is finished (`handed` is told how
 * it ended, before its record goes).
 */
fun FamilySync.resumeOutbox(summary: GroupSummary, names: (String) -> String? = { null }, told: (ChainRoute?, CallEnd) -> Unit = { _, _ -> },
    handed: (String, RoleEnd) -> Unit = { _, _ -> }, continued: (FamilyOutbox.Removal, RemovalEnd) -> Unit = { _, _ -> }): Map<String, CallEnd> = exclusive(summary.id) {
    val ends = LinkedHashMap<String, CallEnd>()
    notMemberLetsGo(summary.id, { ends }) {
        for (kept in outbox.list(userId, summary.id)) {
            val end = sendKept(summary, kept, names = names, told = told)
            ends[kept.outboxId] = end
            if (end == CallEnd.Wiped) return@notMemberLetsGo ends
        }
        finishHandover(summary, names, handed)
        // Removals stopped part way go on, once nothing is kept unresolved (each is staged through the same gate).
        if (outbox.list(userId, summary.id).isEmpty()) continueRemovals(summary, names, continued)
        ends
    }
}

/*
 * A handover kept on this device whose calls are no longer waiting: billing given and still held here, so this account
 * lets go of it now; given and let go of, or never given (its refusal was said with its call), and the record goes.
 */
private fun FamilySync.finishHandover(summary: GroupSummary, names: (String) -> String?, handed: (String, RoleEnd) -> Unit) {
    val groupId = summary.id
    val kept = outbox.handover(userId, groupId) ?: return
    // Nothing new while any change is kept unresolved here (the staging gate would refuse it): the record waits for the next open.
    if (outbox.list(userId, groupId).isNotEmpty()) return
    val to = kept.to
    // Its first call (or a change for them kept before it) still waits for an answer: the next open goes on.
    val waiting = outbox.list(userId, groupId).any { kept ->
        // One the core can't open was said lost by the loop above; anything else is passed on.
        val read = try { ledger.outboxOpen(groupId, kept.outboxId, userId, kept.entry) } catch (_: CoreException.Sealed) { return@any false }
        personOf(read.route()).equals(to, ignoreCase = true)
    }
    if (waiting) return
    val view = (syncRevised(summary).state as? FamilyState.Accepted)?.view ?: return
    fun bills(id: String) = view.members.any { it.userId.equals(id, ignoreCase = true) && "billing" in it.roles }
    val first = names(to) ?: "They"
    val end = when {
        // Let go of already (here or on another device): done.
        !bills(userId) -> { outbox.clearHandover(userId, groupId); return }
        bills(to) -> stepDown(summary, to, first, names)
        // Billing never staged for them (a change for them was still waiting): the handover goes on from its start.
        !kept.staged -> giveThenStepDown(summary, to, first, names)
        // Staged and ended without landing: its refusal was said with its call.
        else -> { outbox.clearHandover(userId, groupId); return }
    }
    // Told whatever it came to, pending included (billing may have landed before the last step went unanswered): the
    // page reads the family again. A pending one keeps its record for the next open.
    handed(to, end)
    if (end is RoleEnd.Pending) return
    if (end != RoleEnd.Wiped) outbox.clearHandover(userId, groupId)
}

/*
 * `body`, with a not-member answer from any of its reads (route 3, 6, 8 or 16) let go of as every removal is
 * (removedNow: two-phase, published to the screens), then `wiped`.
 */
internal fun <T> FamilySync.notMemberLetsGo(groupId: String, wiped: () -> T, body: () -> T): T = try {
    body()
} catch (error: GroupsApiError) {
    if (!error.isNotMember) throw error
    removedNow(groupId)
    wiped()
}

/*
 * Let them in (the web's letInWithoutWords, 6.8): the newcomer pinned first-seen when this account holds no pin of them,
 * then the admission signed over that pin by the core (always as a plain member), kept, and sent. A kept Let them in for
 * them goes first; one kept for their keys before a change is held (KeptOther) until dropped on the person's say. A
 * `stale` answer is dropped and signed again over the winner, three times at most.
 */
fun FamilySync.letIn(summary: GroupSummary, person: PendingPerson): LetIn {
    val groupId = summary.id
    val first = firstNameOf(person.name)
    // Pinned first, outside the family's turn (it saves the settings): first-seen, or the pin held already.
    when (val added = vault.addContact(person.email, writer = person.userId, firstSeen = "family")) {
        is Added.Changed -> return LetIn.Changed(added.change)
        else -> {}
    }
    return exclusive(groupId) {
        notMemberLetsGo(groupId, { LetIn.Wiped }) { admitInTurn(summary, person, first) }
    }
}

private fun FamilySync.admitInTurn(summary: GroupSummary, person: PendingPerson, first: String): LetIn {
    val groupId = summary.id
    // An earlier Let them in for them, kept: sent as it is, or held, before anything new is signed. Only a definite
    // `stale` (or its roster overtaken) lets a new one be signed; one still unanswered stays the only one.
    for (kept in outbox.list(userId, groupId)) {
        when (val end = sendKept(summary, kept, only = ChainRoute.Admit(person.userId.lowercase()), names = { first })) {
            CallEnd.Other, CallEnd.Stale -> {}
            CallEnd.Landed -> if (!waiting(groupId, person.userId)) return LetIn.Landed
            is CallEnd.Pending -> return LetIn.Pending(end.reason)
            is CallEnd.Refused -> return LetIn.Refused(end.words)
            CallEnd.OtherKeys -> return LetIn.KeptOther
            CallEnd.Wiped -> return LetIn.Wiped
        }
    }
    repeat(3) {
        when (val built = stageAdmit(summary, person.userId, first)) {
            is Staged.Refused -> return LetIn.Refused(built.words)
            // Admissions carry no role: neither is met here, and the core's words are said if one ever is.
            Staged.CheckFirst -> return LetIn.Refused(CHECK_MANAGER_FIRST)
            Staged.Unchanged -> return LetIn.Refused(UNCHANGED)
            Staged.Wiped -> return LetIn.Wiped
            Staged.Waiting -> return LetIn.Refused(earlierWaiting(summary.name))
            is Staged.Call -> when (val end = sendKept(summary, built.kept, names = { first })) {
                CallEnd.Landed -> return LetIn.Landed
                is CallEnd.Pending -> return LetIn.Pending(end.reason)
                is CallEnd.Refused -> return LetIn.Refused(end.words)
                CallEnd.OtherKeys, CallEnd.Other -> return LetIn.KeptOther
                CallEnd.Wiped -> return LetIn.Wiped
                // Dropped and synced by the outbox: signed again over the new head. No longer waiting is not let in:
                // another manager may have turned them down meanwhile. Only their active entry on the synced member
                // list is a landing.
                CallEnd.Stale -> if (!waiting(groupId, person.userId)) {
                    return when (val now = admittedNow(summary, person.userId)) {
                        Admitted.Yes -> LetIn.Landed
                        Admitted.No -> LetIn.Refused("$first isn’t waiting to join any more.")
                        Admitted.Wiped -> LetIn.Wiped
                        // The member list couldn't be read: neither let in nor turned down is known.
                        is Admitted.Unknown -> LetIn.Refused(now.words)
                    }
                }
            }
        }
    }
    return LetIn.Refused("${summary.name} keeps changing. Try again in a moment.")
}

/* Whether they are in the family now, as a sync read it: only a member list read whole says yes or no. */
private sealed interface Admitted {
    data object Yes : Admitted
    data object No : Admitted
    data object Wiped : Admitted
    data class Unknown(val words: String) : Admitted
}

/* The family synced now: their active entry (let in, by this phone or another manager), none, or a sync that didn't read. */
private fun FamilySync.admittedNow(summary: GroupSummary, userId: String): Admitted = when (val state = syncRevised(summary).state) {
    is FamilyState.Accepted -> if (state.view.members.any { it.userId.equals(userId, ignoreCase = true) }) Admitted.Yes else Admitted.No
    FamilyState.Wiped -> Admitted.Wiped
    else -> Admitted.Unknown("Couldn’t check ${summary.name}. Try again.")
}

/* Whether they are still waiting to join (route 16): one let in meanwhile, by another manager or an earlier send, isn't. A read that fails throws. */
private fun FamilySync.waiting(groupId: String, userId: String): Boolean =
    api.pending(groupId).any { it.userId.equals(userId, ignoreCase = true) }

internal sealed interface Staged {
    /* `replaced`: workspace documents a rotation couldn't open and carried on empty (the core says which). */
    class Call(val kept: FamilyOutbox.Kept, val replaced: List<com.hushos.core.ReplacedDocument> = emptyList()) : Staged
    class Refused(val words: String) : Staged
    /* The manager rule: their words first (the core's CHECK_MANAGER_FIRST). */
    data object CheckFirst : Staged
    /* Nothing to change: they already have, or don't have, the role. */
    data object Unchanged : Staged
    data object Wiped : Staged
    /* A change kept here earlier is still unresolved: nothing new is staged over it (it would overtake it unseen). */
    data object Waiting : Staged
}

/* A change asked for while an earlier one waits for an answer: refused, nothing kept for it, nothing promised. */
internal fun earlierWaiting(family: String) = "An earlier change to $family hasn’t reached the server yet. Try again once it has."

/* The core's words for the two refusals a role change answers differently (roster_calls.rs). */
internal const val CHECK_MANAGER_FIRST = "Check it’s them first. Managers are checked before they get the role."
internal const val UNCHANGED = "That doesn’t change their roles."

/* A refusal staging met before anything was signed, in its words. */
internal class StageRefused(val words: String) : Exception(words)

/* A promotion whose person isn't verified on this phone now (guard included): their words first. */
private class CheckFirstNeeded : Exception()

/*
 * A roster call built by the core (the web's stageLocked): the family synced first in this turn, so the call builds on
 * the head the server has, and route 3's head checked against the chain that sync accepted (another manager's change
 * since: synced and staged again). Then every member's ML-KEM key (route 6), the group key's seal opened when the core
 * asks (route 8), and `build` given the head's revision. Kept in the outbox before anything is sent.
 */
internal fun FamilySync.stageCall(summary: GroupSummary, build: (view: FamilyView, revision: ULong, kems: Map<String, String>) -> RosterCall): Staged {
    val groupId = summary.id
    // The outbox's one gate, for every roster call: whatever is kept for the family goes first, each as it was signed (what
    // it comes to is said: takeKeptEnds). If anything is still unresolved, nothing new is staged: a new roster would overtake
    // it, and its next resume would drop it as superseded, unseen.
    for (kept in outbox.list(userId, groupId)) {
        if (sendKept(summary, kept, told = { route, end -> keptEnds.add(Triple(groupId, route, end)) }) == CallEnd.Wiped) return Staged.Wiped
    }
    if (outbox.list(userId, groupId).isNotEmpty()) return Staged.Waiting
    var keyOpened = false
    repeat(4) {
        val view = when (val state = syncRevised(summary).state) {
            is FamilyState.Accepted -> state.view
            FamilyState.Wiped -> return Staged.Wiped
            // No answer is not a refusal: nothing was signed, and whatever waits on this (a handover) waits on.
            is FamilyState.Failed -> if (state.transient) throw FamilyFailure(state.words) else return Staged.Refused(state.words)
            else -> return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        }
        val head = api.group(groupId)
        val headVersion = head.headVersion ?: return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        val revision = head.revision ?: return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        if (headVersion != view.rosterVersion.toLong()) return@repeat
        // The ledger reads this account's contact pins from the settings it was handed last.
        vault.familyPin(groupId)
        val identities = fetchIdentities(groupId)
        val kems = identities.mapNotNull { (id, member) -> member.identity?.kemPublicKey?.let { id to it } }.toMap()
        val call = try {
            build(view, revision.toULong(), kems)
        } catch (refused: StageRefused) {
            return Staged.Refused(refused.words)
        } catch (_: CheckFirstNeeded) {
            return Staged.CheckFirst
        } catch (refused: CoreException) {
            return when (refused.message) {
                CHECK_MANAGER_FIRST -> Staged.CheckFirst
                UNCHANGED -> Staged.Unchanged
                else -> Staged.Refused(FamilyWords.error(refused))
            }
        }
        when (call) {
            is RosterCall.Staged -> {
                // Documents it carried on empty are marked for a read-again before the entry exists: never sendable unchecked.
                outbox.markRecheck(this.userId, groupId, call.call.outboxId, call.call.replaced)
                outbox.put(this.userId, groupId, call.call.outboxId, call.call.entry)
                return Staged.Call(FamilyOutbox.Kept(call.call.outboxId, call.call.entry), call.call.replaced)
            }
            // Synced at the top of the next round.
            RosterCall.SyncFirst, RosterCall.OpenFoldersFirst -> {}
            RosterCall.OpenKeyFirst -> {
                if (keyOpened) return Staged.Refused("Another manager needs to open the family before you can change it. Try again later.")
                keyOpened = true
                openGroupKey(groupId, identities)
            }
        }
    }
    return Staged.Refused("${summary.name} keeps changing. Try again in a moment.")
}

/*
 * The admission: staged as every call is, with their keys as route 16 serves them now (a row drawn before their account
 * changed and this phone's Continue holds the old ones).
 */
private fun FamilySync.stageAdmit(summary: GroupSummary, userId: String, first: String): Staged = stageCall(summary) { _, revision, kems ->
    val waiting = api.pending(summary.id).firstOrNull { it.userId.equals(userId, ignoreCase = true) }
        ?: throw StageRefused("$first isn’t waiting to join any more.")
    val served = waiting.identity ?: throw StageRefused("HushOS couldn’t load everyone’s keys. Try again.")
    ledger.admitBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, userId.lowercase(), served,
        emptyList(), kems)
}

/* What a role change or the organizer handover came to. */
sealed interface RoleEnd {
    data object Landed : RoleEnd
    /* No definite answer yet: kept on this phone, sent again at the next open. */
    data class Pending(val reason: String) : RoleEnd
    data class Refused(val words: String) : RoleEnd
    /* The manager rule: managing the family is given only after a check of their words. */
    data object CheckFirst : RoleEnd
    data object Wiped : RoleEnd
}

/*
 * Let them manage the family, or Stop them managing it (route 18, the core's roles_body): granting seals the family's
 * key to them; taking it away replaces the key in the same call (the succession) and seals the new one to every manager
 * who stays. Under the manager rule (a check of their words first), through the outbox as every roster call.
 */
fun FamilySync.changeRole(summary: GroupSummary, userId: String, first: String, change: MembersRole): RoleEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { RoleEnd.Wiped }) {
        callFor(summary, userId, first, unchangedIsDone = false, check = userId.takeIf { change == MembersRole.GRANT }) { revision, kems ->
            ledger.rolesBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, userId.lowercase(), change, kems)
        }
    }
}

/*
 * Make them the organizer (the web's handover): billing given to them, and once that landed and the family was synced,
 * let go of here. The handover is kept on this device before its first call, so one the app stopped in the middle of is
 * finished at the next open (resumeOutbox).
 */
fun FamilySync.handOver(summary: GroupSummary, to: String, first: String, names: (String) -> String? = { null }): RoleEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { RoleEnd.Wiped }) {
        // A handover to someone else still unfinished is settled first (its kept calls sent, its last step taken), never
        // replaced: two handovers under way could leave two organizers. One that is still waiting refuses this one.
        outbox.handover(userId, summary.id)?.takeIf { !it.to.equals(to, ignoreCase = true) }?.let { earlier ->
            val them = names(earlier.to) ?: "someone else"
            var settled: RoleEnd? = null
            for (kept in outbox.list(userId, summary.id)) {
                val read = try { ledger.outboxOpen(summary.id, kept.outboxId, userId, kept.entry) } catch (_: CoreException.Sealed) { continue }
                val about = personOf(read.route())
                if (about.equals(earlier.to, ignoreCase = true) || about.equals(userId, ignoreCase = true)) {
                    if (sendKept(summary, kept, names = names) == CallEnd.Wiped) return@notMemberLetsGo RoleEnd.Wiped
                }
            }
            finishHandover(summary, names) { _, end -> settled = end }
            if (outbox.handover(userId, summary.id) != null) return@notMemberLetsGo RoleEnd.Refused("Finish handing over to $them first.")
            if (settled == RoleEnd.Landed) return@notMemberLetsGo RoleEnd.Refused("$them is the organizer now.")
        }
        outbox.markHandover(userId, summary.id, to)
        giveThenStepDown(summary, to, first, names)
    }
}

/*
 * Finish handing over to {first}: this account and they both hold billing (a handover whose second step was refused,
 * or never sent), and this account lets go of it now, as the handover's last step.
 */
fun FamilySync.finishHandingOver(summary: GroupSummary, to: String, first: String, names: (String) -> String? = { null }): RoleEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { RoleEnd.Wiped }) { stepDown(summary, to, first, names) }
}

/* Who else holds billing beside this account, on a member list where this account does too: a handover left half done. */
fun handoverToFinish(view: FamilyView, me: String): String? {
    val members = view.members
    if (members.none { it.userId.equals(me, ignoreCase = true) && "billing" in it.roles }) return null
    return members.firstOrNull { !it.userId.equals(me, ignoreCase = true) && "billing" in it.roles }?.userId
}

/*
 * The handover's two calls, its record kept: billing to them (under the same check a manager role takes, the web's
 * needsCheckFor), the record marked staged once that call is kept, then this account lets go of it. Pending (unanswered,
 * or a change for them kept before it) keeps the record for the next open; a refusal or a check asked for ends it.
 */
private fun FamilySync.giveThenStepDown(summary: GroupSummary, to: String, first: String, names: (String) -> String?): RoleEnd =
    when (val given = callFor(summary, to, first, unchangedIsDone = true, check = to,
        // The member list itself on every attempt (a first one, a re-sign after `stale`, a resumed handover): while this
        // account and someone else hold billing, it goes to nobody else until that handover is finished. A handover left
        // half done here, or one another device made meanwhile, ends this one, refused.
        before = { view ->
            // Not the organizer any more (another device finished a handover meanwhile, or this one's earlier step down
            // just landed): billing is not this account's to give.
            if (view.members.none { it.userId.equals(userId, ignoreCase = true) && "billing" in it.roles }) {
                val now = view.members.firstOrNull { "billing" in it.roles }?.userId
                throw StageRefused("${now?.let(names) ?: "Someone else"} is the organizer now.")
            }
            handoverToFinish(view, userId)?.takeIf { !it.equals(to, ignoreCase = true) }?.let { other ->
                throw StageRefused("Finish handing over to ${names(other) ?: "them"} first.")
            }
        },
        onStaged = { outbox.markHandover(userId, summary.id, to, staged = true) }) { revision, kems ->
        ledger.handoverBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, Handover.To(to.lowercase()), kems)
    }) {
        RoleEnd.Landed -> stepDown(summary, to, first, names)
        is RoleEnd.Pending, RoleEnd.Wiped -> given
        else -> { outbox.clearHandover(userId, summary.id); given }
    }

/* The handover's second call: this account lets go of billing, someone else holding it now. */
private fun FamilySync.stepDown(summary: GroupSummary, to: String, first: String, names: (String) -> String?): RoleEnd {
    // Only in favour of the person it was handed to: on every freshly synced member list (a first attempt, a re-sign after
    // `stale`), they must still hold billing. Moved to someone else meanwhile (another device), this account stays the
    // organizer, and the person is told who holds it now.
    var moved: String? = null
    val end = callFor(summary, userId, first, unchangedIsDone = true, before = { view ->
        if (view.members.none { it.userId.equals(to, ignoreCase = true) && "billing" in it.roles }) {
            val now = view.members.firstOrNull { !it.userId.equals(userId, ignoreCase = true) && "billing" in it.roles }?.userId
            moved = now?.let { "${names(it) ?: "Someone else"} is the organizer now." } ?: ORGANIZER_FIRST
            throw StageRefused(moved!!)
        }
    }) { revision, kems ->
        ledger.handoverBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, Handover.StepDown, kems)
    }
    return when {
        end == RoleEnd.Landed -> { outbox.clearHandover(userId, summary.id); end }
        end is RoleEnd.Refused && moved != null -> { outbox.clearHandover(userId, summary.id); RoleEnd.Refused(moved!!) }
        end is RoleEnd.Refused -> { outbox.clearHandover(userId, summary.id); RoleEnd.Refused("$first is an organizer now, and so are you still: ${end.words}") }
        else -> end
    }
}

/* The core's and the web's words for letting go of billing while nobody else holds it (roster_calls.rs ORGANIZER_FIRST). */
private const val ORGANIZER_FIRST = "Make someone else the organizer first."

/*
 * One role change of `person` sent through the outbox: an earlier one for them kept here goes first (an unanswered one
 * stays the only one), then the core's call is staged and sent, and signed again over another manager's win (`stale`).
 * A change that no longer changes anything after a landing or a win is done; `unchangedIsDone` says so from the start.
 */
internal fun FamilySync.callFor(summary: GroupSummary, person: String, first: String, unchangedIsDone: Boolean,
    check: String? = null, before: (FamilyView) -> Unit = {}, onStaged: () -> Unit = {}, build: (ULong, Map<String, String>) -> RosterCall): RoleEnd {
    val route = ChainRoute.Member(person.lowercase())
    var moved = unchangedIsDone
    for (kept in outbox.list(userId, summary.id)) {
        when (val end = sendKept(summary, kept, only = route, names = { first })) {
            CallEnd.Other -> {}
            CallEnd.Landed, CallEnd.Stale -> moved = true
            is CallEnd.Pending -> return RoleEnd.Pending(end.reason)
            is CallEnd.Refused -> return RoleEnd.Refused(end.words)
            CallEnd.OtherKeys -> return RoleEnd.Refused(UNCHANGED)
            CallEnd.Wiped -> return RoleEnd.Wiped
        }
    }
    repeat(3) {
        // A promotion: where they stand on this phone now, from the settings and this device's guard read together over
        // the member list just synced (the row's label may be old). A guard that can't be read throws: nothing is signed.
        val built = stageCall(summary) { view, revision, kems ->
            before(view)
            if (check != null && memberStandings(view)[check.lowercase()] != MemberStanding.VERIFIED) throw CheckFirstNeeded()
            build(revision, kems)
        }
        when (built) {
            is Staged.Refused -> return RoleEnd.Refused(built.words)
            Staged.CheckFirst -> return RoleEnd.CheckFirst
            Staged.Unchanged -> return if (moved) RoleEnd.Landed else RoleEnd.Refused(UNCHANGED)
            Staged.Wiped -> return RoleEnd.Wiped
            Staged.Waiting -> return RoleEnd.Refused(earlierWaiting(summary.name))
            is Staged.Call -> when (val end = sendKept(summary, built.kept.also { onStaged() }, names = { first })) {
                CallEnd.Landed -> return RoleEnd.Landed
                is CallEnd.Pending -> return RoleEnd.Pending(end.reason)
                is CallEnd.Refused -> return RoleEnd.Refused(end.words)
                CallEnd.Wiped -> return RoleEnd.Wiped
                CallEnd.OtherKeys, CallEnd.Other -> return RoleEnd.Refused(UNCHANGED)
                // Dropped and synced by the outbox: signed again over the new head.
                CallEnd.Stale -> moved = true
            }
        }
    }
    return RoleEnd.Refused("${summary.name} keeps changing. Try again in a moment.")
}

/* Route 8's seal of the family's group key, opened by the ledger and kept there: the seed never leaves it. */
private fun FamilySync.openGroupKey(groupId: String, identities: Map<String, MemberIdentity>) {
    val seal = try {
        api.keySeal(groupId)
    } catch (error: GroupsApiError) {
        if (error.code == "no-seal") throw FamilyFailure("Another manager needs to open the family before you can change it. Try again later.")
        throw error
    }
    val sealer = identities[seal.sealerUserId.lowercase()]?.takeIf { it.identity != null }
        ?: throw FamilyFailure("HushOS couldn’t load everyone’s keys. Try again.")
    ledger.openGroupKey(vault.ownIdentities(), groupId, seal, base64urlDecode(sealer.identity!!.mlDsaPublicKey),
        SignerHistory(sealer.identity, sealer.links), vault.identityEnvelope(seal.holderKeyVersion))
}

/*
 * The kept Let them in for someone whose account changed since it was made: dropped on the person's say (the web's
 * dropKeptAdmission), so they can be let in again over the keys this phone holds now.
 */
fun FamilySync.dropKeptAdmission(groupId: String, userId: String) = exclusive(groupId) {
    // Judged with the settings read afresh, as every read of the outbox is.
    vault.familyPin(groupId)
    for (kept in outbox.list(this.userId, groupId)) {
        // One the core can't open is left for the loss notice (sendKept); any other failure is passed on.
        val read = try { ledger.outboxOpen(groupId, kept.outboxId, this.userId, kept.entry) } catch (_: CoreException.Sealed) { continue }
        val admits = (read as? OutboxCall.Hold)?.route as? ChainRoute.Admit
        if (admits != null && admits.userId.equals(userId, ignoreCase = true)) outbox.delete(this.userId, groupId, kept.outboxId)
    }
}

private const val RESENDS = 3
private const val RESEND_DELAY_MS = 500L

/* Invite someone (route 11): an email with a link; once they accept, a manager lets them in. Roles none. */
fun FamilySync.invite(groupId: String, email: String) = api.invite(groupId, email.trim())

/* The invitations still open (route 12), and one cancelled (route 13). */
fun FamilySync.invitations(groupId: String): List<OpenInvitation> = api.invitations(groupId)
fun FamilySync.cancelInvitation(groupId: String, invitationId: String) = api.revokeInvitation(groupId, invitationId)

/* Who accepted and waits to be let in (route 16), and Not now on one of them (route 26). */
fun FamilySync.pending(groupId: String): List<PendingPerson> = api.pending(groupId)
fun FamilySync.turnDown(groupId: String, userId: String) = exclusive(groupId) {
    // A Let them in for them kept here must never admit them after they're turned down (if they accept a new invitation),
    // so every kept admission of theirs goes first, in the family's turn, and only then is the decline sent: a decline
    // whose answer is lost, or a cleanup that can't finish (a delete that doesn't hold throws), never leaves one to replay.
    for (kept in outbox.list(this.userId, groupId)) {
        val read = try { ledger.outboxOpen(groupId, kept.outboxId, this.userId, kept.entry) } catch (_: CoreException.Sealed) { continue }
        val admits = read.route() as? ChainRoute.Admit ?: continue
        if (admits.userId.equals(userId, ignoreCase = true)) outbox.delete(this.userId, groupId, kept.outboxId)
    }
    api.decline(groupId, userId)
}
