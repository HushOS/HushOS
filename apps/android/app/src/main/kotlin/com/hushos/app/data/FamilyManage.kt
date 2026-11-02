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
        if (!open()) throw FamilyRecords.Unsaved()
        val target = file(userId, groupId, outboxId) ?: throw FamilyRecords.Unsaved()
        try {
            folder.mkdirs()
            val next = File(target.path + ".next")
            next.writeText(entry)
            if (!next.renameTo(target)) throw java.io.IOException("not moved")
        } catch (_: Exception) {
            throw FamilyRecords.Unsaved()
        }
    }

    fun delete(userId: String, groupId: String, outboxId: String) = synchronized(FamilyCopies.LOCK) {
        if (open()) file(userId, groupId, outboxId)?.delete()
        Unit
    }

    /* This account's entries for the family, oldest first. */
    fun list(userId: String, groupId: String): List<Kept> {
        val prefix = "${userId.lowercase()}_${groupId.lowercase()}_"
        return folder.listFiles().orEmpty().filter { it.name.startsWith(prefix) && it.name.endsWith(".call") }.sortedBy { it.lastModified() }
            .mapNotNull { file ->
                val id = file.name.removePrefix(prefix).removeSuffix(".call").takeIf(FamilyRecords::valid) ?: return@mapNotNull null
                runCatching { Kept(id, file.readText()) }.getOrNull()
            }
    }

    companion object {
        fun of(context: android.content.Context, open: () -> Boolean = { true }) =
            FamilyOutbox(File(File(context.noBackupFilesDir, FamilyRecords.FOLDER), "outbox"), open)
    }
}

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
    /* The server said this account is not in the family: wiped. */
    data object Wiped : CallEnd
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

/* The words a refusal of a roster call says (the web's refusalCopy, the codes Let them in meets). */
internal fun callWords(answer: CallAnswer, first: String?): String = when (answer.code) {
    "not-pending" -> "${first ?: "They"} isn’t waiting to join any more."
    "already-member" -> "That person is already in the family."
    "forbidden" -> "Only someone who manages the family can do that."
    "held" -> "Another manager paused your changes in this family for now."
    "not-member" -> FamilyWords.NOT_IN_FAMILY
    "members-changed" -> "The family’s members changed meanwhile. Try again."
    "left-due" -> "Someone left the family. A manager needs to finish that before anyone can join or roles change."
    "unsupported" -> "Update HushOS to do this."
    "seats" -> answer.message ?: "Every place in the family is taken."
    "rate-limited" -> "That’s been tried too often. Wait a little, then try again."
    else -> if (answer.status == 0) GroupsApiError.NO_ANSWER else "HushOS couldn’t do that just now. Try again in a moment."
}

/*
 * One kept entry sent until a definite answer (the web's sendLocked), inside the family's turn: read back by the core
 * before every attempt (held while this account's pin of an admission's person no longer holds the keys it was staged
 * over; dropped when the committed chain already holds it or moved past it), then its very bytes sent. Unknown answers
 * are sent again a few times, then kept for the next open; grants a call is owed are posted first and the same bytes
 * sent again; `stale`, membership moves and refusals drop it.
 */
internal fun FamilySync.sendKept(summary: GroupSummary, kept: FamilyOutbox.Kept, first: String? = null): CallEnd {
    val groupId = summary.id
    var resends = 0
    var fixes = 0
    while (true) {
        // The settings read again first: the core judges an admission against this account's pin of them now.
        runCatching { vault.familyPin(groupId) }
        val read = try {
            ledger.outboxOpen(groupId, kept.outboxId, userId, kept.entry)
        } catch (sealed: CoreException.Sealed) {
            // Not an entry of this account's (or not this one): never sent, deleted, said lost.
            outbox.delete(userId, groupId, kept.outboxId)
            return CallEnd.Refused("A change saved on this device couldn’t be read, so it wasn’t sent.")
        }
        val (route, body) = when (read) {
            is OutboxCall.Send -> read.route to read.body
            is OutboxCall.Hold -> return if (read.reason == OutboxHold.OTHER_KEYS) CallEnd.OtherKeys else CallEnd.Pending("Kept on this device.")
            is OutboxCall.Landed -> { outbox.delete(userId, groupId, kept.outboxId); run(summary); return CallEnd.Landed }
            is OutboxCall.Superseded -> { outbox.delete(userId, groupId, kept.outboxId); return CallEnd.Stale }
        }
        val answer = api.sendCall(groupId, route, body)
        when (outboxStep(answer.status.toUShort(), answer.code)) {
            OutboxStep.LANDED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                run(summary)
                return CallEnd.Landed
            }
            OutboxStep.RESEND, OutboxStep.REBUILD -> {
                // The same bytes again, a few times now, then at the next open.
                if (++resends >= RESENDS) return CallEnd.Pending(callWords(answer, first))
                Thread.sleep(RESEND_DELAY_MS * resends)
            }
            OutboxStep.SEND_GRANTS -> {
                if (++fixes > 3 || !sendGrants(groupId, answer.data)) return CallEnd.Pending(callWords(answer, first))
            }
            OutboxStep.STALE -> {
                outbox.delete(userId, groupId, kept.outboxId)
                run(summary)
                return CallEnd.Stale
            }
            OutboxStep.MEMBERSHIP_MOVED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                run(summary)
                return CallEnd.Refused(callWords(answer, first))
            }
            OutboxStep.REFUSED -> {
                outbox.delete(userId, groupId, kept.outboxId)
                if (answer.code == "forbidden") run(summary)
                return CallEnd.Refused(callWords(answer, first))
            }
            OutboxStep.WIPED -> {
                runCatching { wipe(groupId) }
                return CallEnd.Wiped
            }
        }
    }
}

/* Route 22's grants a call was told it owes (`grants-due`'s `missing`), sealed by the core; false when they can't be. */
private fun FamilySync.sendGrants(groupId: String, data: JSONObject?): Boolean {
    val missing = data?.optJSONArray("missing") ?: return false
    val kems = fetchIdentities(groupId)
    val owed = (0 until missing.length()).mapNotNull { missing.optJSONObject(it) }.mapNotNull { row ->
        val user = row.optString("userId").lowercase()
        val kem = kems[user]?.identity?.kemPublicKey ?: return@mapNotNull null
        OwedGrant(row.optString("workspaceId"), user, kem)
    }
    if (owed.isEmpty()) return false
    val calls = ledger.grantsBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, owed)
    val requests = (calls as? GrantsCall.Grants)?.requests ?: return false
    return requests.all { api.postGrants(groupId, it.workspaceId, it.body).status in 200..299 }
}

/*
 * Whatever the outbox holds for the family, sent again as it is (the web's resumeOutbox), at every open of a family this
 * account manages: a send that got no answer before a lock, a kill or a relaunch finishes here, never signed again.
 * Each entry's end, by its outbox id.
 */
fun FamilySync.resumeOutbox(summary: GroupSummary): Map<String, CallEnd> = exclusive(summary.id) {
    outbox.list(userId, summary.id).associate { it.outboxId to sendKept(summary, it) }
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
    val served = person.identity ?: return LetIn.Refused("$first isn’t waiting to join any more.")
    // Pinned first, outside the family's turn (it saves the settings): first-seen, or the pin held already.
    when (val added = vault.addContact(person.email, writer = person.userId, firstSeen = "family")) {
        is Added.Changed -> return LetIn.Changed(added.change)
        else -> {}
    }
    return exclusive(groupId) {
        // An earlier Let them in for them, kept: sent as it is, or held, before anything new is signed.
        for (kept in outbox.list(userId, groupId)) {
            when (val end = sendKept(summary, kept, first)) {
                CallEnd.OtherKeys -> return@exclusive LetIn.KeptOther
                CallEnd.Wiped -> return@exclusive LetIn.Wiped
                else -> if (end == CallEnd.Landed && !waiting(groupId, person.userId)) return@exclusive LetIn.Landed
            }
        }
        repeat(3) {
            when (val built = stageAdmit(summary, person.userId, served)) {
                is Staged.Refused -> return@exclusive LetIn.Refused(built.words)
                is Staged.Call -> when (val end = sendKept(summary, built.kept, first)) {
                    CallEnd.Landed -> return@exclusive LetIn.Landed
                    is CallEnd.Pending -> return@exclusive LetIn.Pending(end.reason)
                    is CallEnd.Refused -> return@exclusive LetIn.Refused(end.words)
                    CallEnd.OtherKeys -> return@exclusive LetIn.KeptOther
                    CallEnd.Wiped -> return@exclusive LetIn.Wiped
                    // Dropped and synced by the outbox: signed again over the new head.
                    CallEnd.Stale -> if (!waiting(groupId, person.userId)) return@exclusive LetIn.Landed
                }
            }
        }
        LetIn.Refused("${names(groupId)} keeps changing. Try again in a moment.")
    }
}

/* Whether they are still waiting to join (route 16): one let in meanwhile, by another manager or an earlier send, isn't. */
private fun FamilySync.waiting(groupId: String, userId: String): Boolean =
    runCatching { api.pending(groupId).any { it.userId.equals(userId, ignoreCase = true) } }.getOrDefault(true)

private fun FamilySync.names(groupId: String): String = runCatching { list().firstOrNull { it.id == groupId }?.name }.getOrNull() ?: "The family"

private sealed interface Staged {
    class Call(val kept: FamilyOutbox.Kept) : Staged
    class Refused(val words: String) : Staged
}

/*
 * The admission built by the core, with what it asks first done here: the family synced (its committed chain and its
 * folders open), the group key's seal opened (route 8), every member's ML-KEM key (route 6), and the head's revision
 * (route 3). Kept in the outbox before anything is sent.
 */
private fun FamilySync.stageAdmit(summary: GroupSummary, userId: String, served: com.hushos.core.PublicIdentity): Staged {
    val groupId = summary.id
    var synced = false
    var keyOpened = false
    repeat(4) {
        // The ledger reads this account's contact pin of them from the settings it was handed last.
        vault.familyPin(groupId)
        val revision = api.group(groupId).revision.toULong()
        val identities = fetchIdentities(groupId)
        val kems = identities.mapNotNull { (id, member) -> member.identity?.kemPublicKey?.let { id to it } }.toMap()
        val call = try {
            ledger.admitBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, revision, userId.lowercase(), served,
                emptyList(), kems)
        } catch (refused: CoreException) {
            return Staged.Refused(FamilyWords.error(refused))
        }
        when (call) {
            is RosterCall.Staged -> {
                outbox.put(this.userId, groupId, call.call.outboxId, call.call.entry)
                return Staged.Call(FamilyOutbox.Kept(call.call.outboxId, call.call.entry))
            }
            RosterCall.SyncFirst, RosterCall.OpenFoldersFirst -> {
                if (synced) return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
                synced = true
                if (run(summary) !is FamilyState.Accepted) return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
            }
            RosterCall.OpenKeyFirst -> {
                if (keyOpened) return Staged.Refused("Another manager needs to open the family before you can change it. Try again later.")
                keyOpened = true
                openGroupKey(groupId, identities)
            }
        }
    }
    return Staged.Refused("Couldn’t check ${summary.name}. Try again.")
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
    for (kept in outbox.list(this.userId, groupId)) {
        val read = runCatching { ledger.outboxOpen(groupId, kept.outboxId, this.userId, kept.entry) }.getOrNull()
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
