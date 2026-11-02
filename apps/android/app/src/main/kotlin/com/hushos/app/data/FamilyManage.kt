package com.hushos.app.data

import com.hushos.core.ChainRoute
import com.hushos.core.CoreException
import com.hushos.core.GrantsCall
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
     * by the core then, never signed again), but the answer that dropped it isn't to be taken as done.
     */
    fun delete(userId: String, groupId: String, outboxId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        val target = file(userId, groupId, outboxId) ?: return@synchronized
        if (!target.delete() && target.exists()) throw OutboxUnsaved()
    }

    /* Every entry of this account's for the family: a not-member wipe takes them with the family (the web's forgetGroup). */
    fun deleteGroup(userId: String, groupId: String) = synchronized(FamilyCopies.LOCK) {
        if (!open()) return@synchronized
        for (file in entries(userId, groupId)) if (!file.delete() && file.exists()) throw OutboxUnsaved()
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
    /* Refused, in the families' words; the entry is gone. */
    data class Refused(val words: String) : CallEnd
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
 * `only`: an admission of that person, else `Other` and nothing is touched. `names` gives a person's first name.
 */
internal fun FamilySync.sendKept(summary: GroupSummary, kept: FamilyOutbox.Kept, only: String? = null, names: (String) -> String? = { null }): CallEnd {
    val groupId = summary.id
    var resends = 0
    var fixes = 0
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
            ledger.outboxOpen(groupId, kept.outboxId, userId, kept.entry)
        } catch (sealed: CoreException.Sealed) {
            // Not an entry of this account's any more (sealed before a master-key change): never sent, deleted, said lost.
            outbox.delete(userId, groupId, kept.outboxId)
            return CallEnd.Refused("A change to ${summary.name} hadn’t reached the server and couldn’t be opened on this device. Make it again.")
        }
        val admits = (read.route() as? ChainRoute.Admit)?.userId
        if (only != null && (admits == null || !admits.equals(only, ignoreCase = true))) return CallEnd.Other
        val first = admits?.let(names)
        val (route, body) = when (read) {
            is OutboxCall.Send -> read.route to read.body
            is OutboxCall.Hold -> return if (read.reason == OutboxHold.OTHER_KEYS) CallEnd.OtherKeys else CallEnd.Pending("Kept on this device.")
            is OutboxCall.Landed -> { outbox.delete(userId, groupId, kept.outboxId); syncRevised(summary); return CallEnd.Landed }
            is OutboxCall.Superseded -> { outbox.delete(userId, groupId, kept.outboxId); return CallEnd.Stale }
        }
        val answer = api.sendCall(groupId, route, body)
        when (outboxStep(answer.status.toUShort(), answer.code)) {
            OutboxStep.LANDED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                syncRevised(summary)
                return CallEnd.Landed
            }
            OutboxStep.RESEND, OutboxStep.REBUILD -> {
                // The same bytes again, a few times now, then at the next open.
                if (++resends >= RESENDS) return CallEnd.Pending(callWords(answer, first, summary.name))
                Thread.sleep(RESEND_DELAY_MS * resends)
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
                outbox.delete(userId, groupId, kept.outboxId)
                syncRevised(summary)
                return CallEnd.Stale
            }
            OutboxStep.MEMBERSHIP_MOVED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                syncRevised(summary)
                return CallEnd.Refused(callWords(answer, first, summary.name))
            }
            OutboxStep.REFUSED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                if (answer.code == "forbidden") syncRevised(summary)
                return CallEnd.Refused(callWords(answer, first, summary.name))
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

private fun OutboxCall.route(): ChainRoute = when (this) {
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
 * Each entry's end, by its outbox id.
 */
fun FamilySync.resumeOutbox(summary: GroupSummary, names: (String) -> String? = { null }): Map<String, CallEnd> = exclusive(summary.id) {
    val ends = LinkedHashMap<String, CallEnd>()
    notMemberLetsGo(summary.id, { ends }) {
        for (kept in outbox.list(userId, summary.id)) {
            val end = sendKept(summary, kept, names = names)
            ends[kept.outboxId] = end
            if (end == CallEnd.Wiped) break
        }
        ends
    }
}

/*
 * `body`, with a not-member answer from any of its reads (route 3, 6, 8 or 16) let go of as every removal is
 * (removedNow: two-phase, published to the screens), then `wiped`.
 */
private fun <T> FamilySync.notMemberLetsGo(groupId: String, wiped: () -> T, body: () -> T): T = try {
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
        when (val end = sendKept(summary, kept, only = person.userId, names = { first })) {
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
            Staged.Wiped -> return LetIn.Wiped
            is Staged.Call -> when (val end = sendKept(summary, built.kept, names = { first })) {
                CallEnd.Landed -> return LetIn.Landed
                is CallEnd.Pending -> return LetIn.Pending(end.reason)
                is CallEnd.Refused -> return LetIn.Refused(end.words)
                CallEnd.OtherKeys, CallEnd.Other -> return LetIn.KeptOther
                CallEnd.Wiped -> return LetIn.Wiped
                // Dropped and synced by the outbox: signed again over the new head.
                CallEnd.Stale -> if (!waiting(groupId, person.userId)) return LetIn.Landed
            }
        }
    }
    return LetIn.Refused("${summary.name} keeps changing. Try again in a moment.")
}

/* Whether they are still waiting to join (route 16): one let in meanwhile, by another manager or an earlier send, isn't. A read that fails throws. */
private fun FamilySync.waiting(groupId: String, userId: String): Boolean =
    api.pending(groupId).any { it.userId.equals(userId, ignoreCase = true) }

private sealed interface Staged {
    class Call(val kept: FamilyOutbox.Kept) : Staged
    class Refused(val words: String) : Staged
    data object Wiped : Staged
}

/*
 * The admission built by the core (the web's stageLocked): the family synced first in this turn, so the call builds on
 * the head the server has, and route 3's head checked against the chain that sync accepted (another manager's change
 * since: synced and staged again). Then their keys as route 16 serves them now (a row drawn before their account changed
 * and this phone's Continue holds the old ones), every member's ML-KEM key (route 6), the group key's seal opened when the
 * core asks (route 8), and the head's revision. Kept in the outbox before anything is sent.
 */
private fun FamilySync.stageAdmit(summary: GroupSummary, userId: String, first: String): Staged {
    val groupId = summary.id
    var keyOpened = false
    repeat(4) {
        val view = when (val state = syncRevised(summary).state) {
            is FamilyState.Accepted -> state.view
            FamilyState.Wiped -> return Staged.Wiped
            is FamilyState.Failed -> return Staged.Refused(state.words)
            else -> return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        }
        val head = api.group(groupId)
        val headVersion = head.headVersion ?: return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        val revision = head.revision ?: return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
        if (headVersion != view.rosterVersion.toLong()) return@repeat
        val waiting = api.pending(groupId).firstOrNull { it.userId.equals(userId, ignoreCase = true) }
            ?: return Staged.Refused("$first isn’t waiting to join any more.")
        val served = waiting.identity ?: return Staged.Refused("HushOS couldn’t load everyone’s keys. Try again.")
        // The ledger reads this account's contact pin of them from the settings it was handed last.
        vault.familyPin(groupId)
        val identities = fetchIdentities(groupId)
        val kems = identities.mapNotNull { (id, member) -> member.identity?.kemPublicKey?.let { id to it } }.toMap()
        val call = try {
            ledger.admitBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, revision.toULong(), userId.lowercase(), served,
                emptyList(), kems)
        } catch (refused: CoreException) {
            return Staged.Refused(FamilyWords.error(refused))
        }
        when (call) {
            is RosterCall.Staged -> {
                outbox.put(this.userId, groupId, call.call.outboxId, call.call.entry)
                return Staged.Call(FamilyOutbox.Kept(call.call.outboxId, call.call.entry))
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
fun FamilySync.turnDown(groupId: String, userId: String) = api.decline(groupId, userId)
