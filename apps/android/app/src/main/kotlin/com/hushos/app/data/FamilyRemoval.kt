package com.hushos.app.data

import com.hushos.core.AreaRotation
import com.hushos.core.ChainRoute
import com.hushos.core.MembersRole
import com.hushos.core.PreviousRoot
import com.hushos.core.PreviousRootRepair
import com.hushos.core.ReplacedDocument
import com.hushos.core.RosterCall
import com.hushos.core.ServedDocument
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import org.json.JSONObject

/*
 * The calls that give family folders new keys, on a manager's phone (docs/groups-mobile-plan.md, Android 5b; the web's
 * lib/groups/removal.ts, rotations.ts, outbox.ts's rebuild and spaces.ts's deleteFamilyFolder): Remove from family, marking
 * the departed left (route 3's `due.markLeft`, a 409 `left-due`), a folder's key replacement (route 3's `due.rotations`),
 * Delete family folder, and the previous top-folder key a walk needs repaired. Every one is the core's (Core 5b), staged
 * over the committed chain and sent through the outbox with #265's rules; a call the server answers `rotating`,
 * `epoch-stale`, `root-moved` or `document-stale` has its folders gathered again and its rotations made again under the same
 * keys and roster (`outbox_rebuild`), never signed again.
 */

/* The workspace documents this client knows (the web's DOCUMENT_KINDS): read for every rotation, with any a 409 names. */
private val DOCUMENT_KINDS = listOf("tags")
private val KIND = Regex("^[a-z][a-z0-9-]{0,31}$")

/* A key epoch drawn for a family folder's roster rotation: a write into the folder, decided at its entry as every family write is. */
internal fun Vault.drawFamilyEpoch(workspaceId: String): ULong = writing {
    if (!familyTarget(workspaceId)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
    api.allocateEpoch(workspaceId)
}

/*
 * One family folder gathered for a rotation (the web's createRotationSource): its top folder as route 29 serves it, a target
 * epoch drawn after it was read (above every epoch the folder carries), and every workspace document of `kinds` (always
 * `folderKinds`: staging, every rebuild and every recheck ask the same function). Read again for every rebuild, never kept.
 * Shares and links are never handed on: nothing records who made them in a family folder, so the rotation closes them (the
 * web does too).
 */
internal fun FamilySync.gather(groupId: String, workspaceId: String, kinds: FolderKinds): AreaRotation {
    val ws = workspaceId.lowercase()
    val served = api.areaRoot(groupId, ws)
    val target = vault.drawFamilyEpoch(ws)
    val documents = kinds.kinds.mapNotNull { kind ->
        vault.api.document(ws, kind)?.let { (envelope, version) -> ServedDocument(kind, version.toULong(), base64urlDecode(envelope)) }
    }
    val node = served.node
    // As a walk takes the top folder, then put under the folder's next key version (the worker checks it against the roster).
    val root = rotating(served, node.id, target, ws).copy(parentKeyEpoch = node.parentKeyEpoch + 1uL, shareIds = emptyList(), linkIds = emptyList())
    return AreaRotation(ws, target, root, (node.changeSeq ?: 0).toULong(), documents)
}

/*
 * The document kinds a folder's rotation carries, the one answer for staging, rebuilds and rechecks: the kinds this client
 * knows, every kind the call's rotation of that folder already carries (`body`: a kind a 409 once named stays named, so a
 * later rebuild or recheck never drops it and meets `document-stale` for it again), and any the server names now.
 */
@JvmInline internal value class FolderKinds(val kinds: List<String>)

internal fun folderKinds(body: String?, workspaceId: String, named: Collection<String> = emptyList()): FolderKinds =
    FolderKinds((DOCUMENT_KINDS + kindsIn(body, workspaceId) + named).filter(KIND::matches).toSortedSet().toList())

/* The kinds `body`'s rotation of the folder carries. */
private fun kindsIn(body: String?, workspaceId: String): List<String> {
    val json = body?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyList()
    val wires = json.optJSONArray("rotations")?.let { list -> (0 until list.length()).mapNotNull(list::optJSONObject) }.orEmpty() +
        listOfNotNull(json.optJSONObject("rotation"))
    val wire = wires.firstOrNull { it.optString("workspaceId").equals(workspaceId, ignoreCase = true) } ?: return emptyList()
    val documents = wire.optJSONArray("documents") ?: return emptyList()
    return (0 until documents.length()).mapNotNull { documents.optJSONObject(it)?.optString("kind")?.takeIf(String::isNotEmpty) }
}

/* Every live family folder gathered: what a removal or marking someone left rotates. */
private fun FamilySync.gatherLive(groupId: String): List<AreaRotation> =
    (liveAreas(groupId) ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)).map { gather(groupId, it, folderKinds(null, it)) }

/* What a rotating call's rebuild came to. */
internal sealed interface Rebuilt {
    class Kept(val kept: FamilyOutbox.Kept) : Rebuilt
    /* Not rebuilt now: kept as it was, with why. */
    class Unsent(val words: String) : Rebuilt
    data object Wiped : Rebuilt
}

/* The web's words for a 409 naming a folder the kept call doesn't rotate: walked or rebuilt by nobody here. */
private const val NOT_THIS_CALLS = "The server named a folder this change does not rotate."

/*
 * A kept rotating call rebuilt after the server's answer (the web's sendLocked rebuild cases): `rotating` walks the run the
 * server names to its end first (only in a folder the call rotates: a walk re-keys records as the walker); `epoch-stale` and
 * `root-moved` gather every folder the call rotates again; `document-stale` the folders and kinds it names. A removal's hold is
 * placed again first, so the person can't draw an epoch above the new target meanwhile. The new entry is kept (same outbox
 * id) before it is sent.
 */
internal fun FamilySync.rebuildKept(summary: GroupSummary, kept: FamilyOutbox.Kept, route: ChainRoute, body: String, answer: CallAnswer): Rebuilt {
    val groupId = summary.id
    val pending = callWords(answer, null, summary.name)
    val rotated = rotatedAreas(body)
    val areas: Map<String, List<String>> = when (answer.code) {
        "rotating" -> {
            val data = answer.data ?: return Rebuilt.Unsent(pending)
            val ws = data.optString("workspaceId").lowercase()
            if (ws !in rotated) return Rebuilt.Unsent(NOT_THIS_CALLS)
            val nodeId = data.optString("nodeId").takeIf(FamilyRecords::valid) ?: return Rebuilt.Unsent(pending)
            val target = data.optLong("targetEpoch", -1L).takeIf { it > 0 } ?: return Rebuilt.Unsent(pending)
            holdAgain(summary, route)?.let { return it }
            walk(groupId, WalkTarget(ws, data.optString("rotationId").ifEmpty { null }, nodeId, target.toULong()))
            mapOf(ws to emptyList())
        }
        "epoch-stale", "root-moved" -> rotated.associateWith { emptyList() }
        "document-stale" -> {
            val named = staleDocuments(answer.data)
            if (named.isEmpty()) return Rebuilt.Unsent(pending)
            if (named.keys.any { it !in rotated }) return Rebuilt.Unsent(NOT_THIS_CALLS)
            named
        }
        else -> return Rebuilt.Unsent(pending)
    }
    holdAgain(summary, route)?.let { return it }
    return Rebuilt.Kept(rebuildWith(summary.id, kept, areas.mapValues { (ws, named) -> folderKinds(body, ws, named) }))
}

/*
 * The kept call's rotations of `areas`' folders (with the kinds named, or all) made again by the core, kept over the old
 * entry under the same id. Documents that didn't open are read again once and the rotations of their folders made again
 * (the server may have served junk to this device alone; the web's refetchReplaced). Every rebuild is marked first, with the
 * folders it rebuilt, even when nothing was carried on empty: finishing it rewrites those folders' notes to what the call
 * now carries on empty, so a note from an earlier rebuild never outlives a rebuild that read the document fine.
 */
private fun FamilySync.rebuildWith(groupId: String, kept: FamilyOutbox.Kept, areas: Map<String, FolderKinds>): FamilyOutbox.Kept {
    val rotations = areas.map { (ws, kinds) -> gather(groupId, ws, kinds) }
    val first = ledger.outboxRebuild(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, kept.outboxId, kept.entry, rotations)
    val recheck = FamilyOutbox.Recheck(areas.keys.map { it.lowercase() }.toSet(), first.replaced)
    // The rebuilt entry and its marker, in one write: no crash leaves the marker describing the call it replaced.
    outbox.put(userId, groupId, first.outboxId, first.entry, recheck)
    return finishRecheck(groupId, FamilyOutbox.Kept(first.outboxId, first.entry), first.body, recheck)
}

/*
 * An entry's recheck settled: documents carried on empty read again once (their folders gathered with those kinds) and the
 * call rebuilt; then, in one write of the entry's file, the call as rebuilt, the notes of every folder the rebuild touched
 * rewritten to what the call now carries on empty (only that: one read fine now loses its note), and the marker gone. A
 * failure or a killed process before that write leaves the entry as it was, marked, and the next send settles it first.
 */
internal fun FamilySync.finishRecheck(groupId: String, kept: FamilyOutbox.Kept, body: String, recheck: FamilyOutbox.Recheck): FamilyOutbox.Kept {
    var current = kept
    var still = recheck.replaced
    if (still.isNotEmpty()) {
        // Each folder gathered with every kind its rotation carries (folderKinds), not only the ones read again: a kind
        // dropped here would be refused `document-stale` at every send.
        val again = still.groupBy({ it.workspaceId.lowercase() }, { it.kind }).map { (ws, kinds) -> gather(groupId, ws, folderKinds(body, ws, kinds)) }
        val call = ledger.outboxRebuild(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, kept.outboxId, kept.entry, again)
        still = call.replaced
        current = FamilyOutbox.Kept(call.outboxId, call.entry)
    }
    // The entry read again, its folders' notes and the marker gone, in one write.
    outbox.settle(userId, groupId, current.outboxId, current.entry, recheck.areas + recheck.replaced.map { it.workspaceId.lowercase() }, still)
    return current
}

/* A removal's hold placed again before its folders are read (route 27 extends a live one); a refusal keeps the call as it is. */
private fun FamilySync.holdAgain(summary: GroupSummary, route: ChainRoute): Rebuilt? {
    if (route !is ChainRoute.Remove) return null
    return try {
        api.hold(summary.id, route.userId)
        null
    } catch (error: GroupsApiError) {
        if (error.isNotMember) throw error
        Rebuilt.Unsent(callWords(CallAnswer(error.status, error.code, null, error.message), null, summary.name))
    }
}

/* The folders a kept call's body rotates, lowercase. */
private fun rotatedAreas(body: String): Set<String> {
    val json = runCatching { JSONObject(body) }.getOrNull() ?: return emptySet()
    val wires = json.optJSONArray("rotations")?.let { list -> (0 until list.length()).mapNotNull(list::optJSONObject) }.orEmpty() +
        listOfNotNull(json.optJSONObject("rotation"))
    return wires.mapNotNull { it.optString("workspaceId").lowercase().takeIf(FamilyRecords::valid) }.toSet()
}

/* 409 document-stale's folders and kinds: every one its `stale` list names, or the one it names on its own. */
private fun staleDocuments(data: JSONObject?): Map<String, List<String>> {
    val listed = data?.optJSONArray("stale")?.let { list -> (0 until list.length()).mapNotNull(list::optJSONObject) }.orEmpty()
    val rows = listed.ifEmpty { listOfNotNull(data?.takeIf { it.has("workspaceId") && it.has("kind") }) }
    return rows.mapNotNull { row ->
        val ws = row.optString("workspaceId").lowercase().takeIf(FamilyRecords::valid) ?: return@mapNotNull null
        val kind = row.optString("kind").takeIf(KIND::matches) ?: return@mapNotNull null
        ws to kind
    }.groupBy({ it.first }, { it.second }).mapValues { (_, kinds) -> kinds.distinct().sorted() }
}

/* What one rotating call came to: sent, refused before anything was signed, or a removal. Documents carried on empty are said on landing (takeCleared). */
sealed interface Rotated {
    data class Sent(val end: CallEnd) : Rotated
    /* `retry`: nothing definite was said (Staged.Refused's). */
    /* An earlier change kept here is unresolved: nothing was staged (the outbox's gate). */
    data object Waiting : Rotated
    data class Refused(val words: String, val retry: Boolean = false) : Rotated
    data object Wiped : Rotated
}

/*
 * A rotating call staged, then sent: documents the core couldn't open (and carried on empty) read again once and the call's
 * rotations of their folders made again (the server may have served junk to this device alone; the web's refetchReplaced),
 * and whatever still doesn't open is said once the call lands.
 */
private fun FamilySync.rotatingCall(summary: GroupSummary, names: (String) -> String?, beforeKept: (String) -> Unit = {},
    build: (FamilyView, ULong, Map<String, String>) -> RosterCall): Rotated =
    when (val staged = stageCall(summary, beforeKept, build)) {
        // sendKept settles the entry's recheck (its documents read again) before it is first sent.
        is Staged.Call -> Rotated.Sent(sendKept(summary, staged.kept, names = names))
        is Staged.Refused -> Rotated.Refused(staged.words, staged.retry)
        Staged.Wiped -> Rotated.Wiped
        Staged.CheckFirst -> Rotated.Refused(CHECK_MANAGER_FIRST)
        Staged.Unchanged -> Rotated.Refused(UNCHANGED)
        Staged.Waiting -> Rotated.Waiting
    }

/* The web's documents-cleared words: a folder's document that didn't open while its keys were replaced started again empty. */
fun clearedWords(kind: String): String =
    "A family folder’s ${if (kind == "tags") "tags" else "settings"} couldn’t be opened while its keys were replaced, and started again empty."

/* The steps a removal shows as it goes (the web's RemovalStep). */
enum class RemovalStep { DEMOTE, HOLD, FINISH, REMOVE }

/* What Remove from family came to (the web's RemovalOutcome). */
sealed interface RemovalEnd {
    /* They're out. */
    data object Removed : RemovalEnd
    /* Someone paused this manager's changes (route 27 answered `held`): who, when route 3 says, and whether the person removed manages the family. */
    data class Held(val heldBy: String?, val targetManages: Boolean) : RemovalEnd
    /* They're not an active member any more: nothing to remove. */
    data object Changed : RemovalEnd
    /*
     * They're still in the family, but not as confirmed: their entry changed (a role, their keys, let in again) or the server
     * said the member list moved. Nothing was changed; the person looks again and confirms (the web's members-changed words).
     */
    data object Moved : RemovalEnd
    /* Kept on this phone and sent again at the next open. */
    data class Pending(val words: String) : RemovalEnd
    data class Failed(val words: String) : RemovalEnd
    data object Wiped : RemovalEnd
    /* Plans they pay for that give nothing end with the removal: asked first, nothing changed. */
    /*
     * `carried`: the removal as it stood (its bindings: the membership confirmed and the one its own demotion left), handed
     * back with the plans' confirmation (removeMember's `carried`), so a demotion already made is still this removal's.
     */
    data class EndsLapsed(val plans: List<FamilyLapsedPlan>, val carried: FamilyOutbox.Removal? = null) : RemovalEnd
}

private const val MAX_REBUILDS = 3

/*
 * Remove from family (the web's removeMember): the plans they pay for that end with them asked first (`endsLapsed` names
 * those the remover confirmed, by id); with `demoteFirst`, `members` taken from them (the way out when they hold this
 * manager); then the hold (route 27) stops their writes and walks in the family's folders, any walk already running in a
 * folder is finished, and only then is the roster marking them left staged, every live folder rotated, with the succession
 * when they managed the family and the new keys' grants, in one call (route 19). A 409 `left-due` marks the departed left
 * first (route 7) and removes again; another manager's change (`stale`) is built over. A removal kept unanswered goes first:
 * a second press signs nothing new while it waits.
 */
fun FamilySync.removeMember(summary: GroupSummary, userId: String, first: String, confirmed: FamilyMember, demoteFirst: Boolean = false, endsLapsed: List<String> = emptyList(),
    names: (String) -> String? = { null }, carried: FamilyOutbox.Removal? = null, onStep: (RemovalStep) -> Unit = {}): RemovalEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { RemovalEnd.Wiped }) {
        // Plans confirmed after `ends-lapsed`: the same removal goes on with its bindings, only the confirmed plans new.
        val removal = carried?.takeIf { it.userId.equals(userId, ignoreCase = true) }?.copy(endsLapsed = endsLapsed, outboxId = null)
            ?: FamilyOutbox.Removal(userId.lowercase(), first, endsLapsed, demoteFirst, FamilyOutbox.Membership.of(confirmed))
        removeKept(summary, removal, names, onStep)
    }
}

/* A removal's member list moved to a state nobody confirmed (FamilyOutbox.Removal.bound): thrown from a build, nothing staged. */
private class NotConfirmed(val present: Boolean) : Exception("not the membership confirmed")

/*
 * One removal's turn. Its intent is kept on this device first, before any read or call (a write that may not be on disk
 * throws, and nothing is asked of the server), so every pending end is a promise the next open keeps (continueRemovals).
 * A definite end drops it: removed, changed, refused, plans to confirm, wiped. A pending end keeps it: a departure still to
 * mark left, a demotion or the removal unanswered or retryable, a change kept before it, a sync that got no answer. A failure
 * of the network's or the server's for now is pending too (said as kept for later). Any other failure is said as it is and
 * keeps it as well: the removal may already be kept in the outbox, and the next open tries again from where it is.
 */
private fun FamilySync.removeKept(summary: GroupSummary, removal: FamilyOutbox.Removal, names: (String) -> String?, onStep: (RemovalStep) -> Unit): RemovalEnd {
    outbox.keepRemoval(userId, summary.id, removal)
    // The intent as the turn last wrote it (its demotion's version, its last entry): what a pending end keeps.
    val turn = RemovalTurn(removal)
    val end = try {
        removeInTurn(summary, turn, names, onStep)
    } catch (moved: NotConfirmed) {
        if (moved.present) RemovalEnd.Moved else RemovalEnd.Changed
    } catch (error: Exception) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        // Kept again in case an entry's end retired it on the way (finish): this turn hadn't ended.
        outbox.keepRemoval(userId, summary.id, turn.removal)
        if (error is NotAuthenticated || !FamilySync.transient(error)) throw error
        return RemovalEnd.Pending(keptForLater(summary.name))
    }
    // A pending end keeps the turn's intent (written again: an entry this turn went on from may have retired it).
    if (end is RemovalEnd.Pending) outbox.keepRemoval(userId, summary.id, turn.removal)
    else outbox.dropRemoval(userId, summary.id, removal.userId)
    // Plans to confirm: handed back with the removal's bindings, for the confirmation to go on with.
    if (end is RemovalEnd.EndsLapsed) return end.copy(carried = turn.removal)
    return end
}

/*
 * Removals a person confirmed that stopped part way, continued at an open once nothing is kept unresolved (resumeOutbox):
 * each as it was asked for (the plans confirmed then, a demotion first). `continued` hears each end; one still pending stays.
 */
internal fun FamilySync.continueRemovals(summary: GroupSummary, names: (String) -> String?, continued: (FamilyOutbox.Removal, RemovalEnd) -> Unit) {
    for (removal in outbox.removals(userId, summary.id)) {
        val end = removeKept(summary, removal, names) {}
        continued(removal, end)
        if (end == RemovalEnd.Wiped || end is RemovalEnd.Pending) return
    }
}

/* The family synced, as a removal reads it: the view, or what to say instead. */
/*
 * The family synced, as a removal reads it: the view, or what to say instead. Only the account's removal is definite; a sync
 * that got no answer, or a family that couldn't be checked or looks different here, keeps the removal's intent (Pending).
 */
private fun FamilySync.syncedView(summary: GroupSummary): Pair<FamilyView?, RemovalEnd?> = when (val state = syncRevised(summary).state) {
    is FamilyState.Accepted -> state.view to null
    FamilyState.Wiped -> null to RemovalEnd.Wiped
    is FamilyState.Fork -> null to RemovalEnd.Pending("${summary.name} looks different on this device.")
    is FamilyState.Failed -> null to RemovalEnd.Pending(if (state.transient) keptForLater(summary.name) else "Couldn’t check ${summary.name}. Try again.")
    else -> null to RemovalEnd.Pending("Couldn’t check ${summary.name}. Try again.")
}

private fun manages(view: FamilyView, userId: String) = view.members.any { it.userId.equals(userId, ignoreCase = true) && "members" in it.roles }
private fun inFamily(view: FamilyView, userId: String) = view.members.any { it.userId.equals(userId, ignoreCase = true) }

/* The web's words for a removal kept for the next open. */
private fun keptForLater(family: String) =
    "HushOS couldn’t finish this yet. This device keeps the change and sends it the next time you open $family."

/*
 * Every read the removal acts on is checked against the membership confirmed (`bound`): a person let in again elsewhere, or
 * whose entry another manager or their own account changed, is Changed (nothing staged over them), never removed unasked.
 * The builds check the very list the call is signed over.
 */
private class RemovalTurn(var removal: FamilyOutbox.Removal)

private fun FamilySync.removeInTurn(summary: GroupSummary, turn: RemovalTurn, names: (String) -> String?, onStep: (RemovalStep) -> Unit): RemovalEnd {
    val confirmed = turn.removal
    val userId = confirmed.userId
    val first = confirmed.first
    val demoteFirst = confirmed.demote
    val endsLapsed = confirmed.endsLapsed
    var removal by turn::removal
    // Every entry this turn stages is linked to its intent before it is written (stageCall's beforeKept), so the entry's end
    // for good retires the intent with it (sendKept's finish), and staging anew keeps it again.
    fun link(outboxId: String) {
        removal = removal.copy(outboxId = outboxId.lowercase())
        outbox.keepRemoval(this.userId, summary.id, removal)
    }
    fun entry(view: FamilyView) = view.members.firstOrNull { it.userId.equals(userId, ignoreCase = true) }
    fun requireBound(view: FamilyView) { entry(view)?.let { if (!removal.bound(it)) throw NotConfirmed(present = true) } }
    val groupId = summary.id
    val family = summary.name
    val named = { id: String -> if (id.equals(userId, ignoreCase = true)) first else names(id) }
    // A removal of them kept unanswered (a lock, a kill, no answer) goes first: never a second one signed beside it.
    for (kept in outbox.list(this.userId, groupId)) {
        when (val end = sendKept(summary, kept, only = ChainRoute.Remove(userId, emptyList()), names = named)) {
            CallEnd.Other, CallEnd.Stale -> {}
            // Their kept removal landed (its intent retired as it did): done, whatever the family became since.
            CallEnd.Landed -> {
                val (view, stop) = syncedView(summary)
                if (view == null && stop == RemovalEnd.Wiped) return stop
                return RemovalEnd.Removed
            }
            is CallEnd.Pending -> return RemovalEnd.Pending(keptForLater(family))
            // Refused as kept: a departure still to mark left is done below (staged anew); the rest is definite.
            is CallEnd.Refused -> when (end.code) {
                "left-due" -> {}
                "busy" -> return RemovalEnd.Pending(keptForLater(family))
                "members-changed" -> return membersChanged(summary, userId)
                "ends-lapsed" -> return RemovalEnd.EndsLapsed(FamilyLapsedPlan.listIn(end.data))
                else -> return RemovalEnd.Failed(end.words)
            }
            CallEnd.OtherKeys -> return RemovalEnd.Failed("Nothing was changed.")
            CallEnd.Wiped -> return RemovalEnd.Wiped
        }
    }
    var (view, stop) = syncedView(summary)
    if (view == null) return stop!!
    if (!inFamily(view, userId)) return RemovalEnd.Changed
    requireBound(view!!)
    // Asked first, before anything changes: the plans they pay for that give nothing, which removing them ends. One not
    // confirmed yet stops here; one that can't be ended is said in the server's words.
    val plans = try {
        api.removalPreview(groupId, userId)
    } catch (error: GroupsApiError) {
        if (error.code == "payer") return RemovalEnd.Failed(error.message ?: error.words)
        throw error
    }
    if (plans.any { it.id !in endsLapsed }) return RemovalEnd.EndsLapsed(plans)

    if (demoteFirst && manages(view, userId)) {
        onStep(RemovalStep.DEMOTE)
        // The member list the demotion is staged over (callFor hands it to `before` right before the build).
        var stagedOver: FamilyView? = null
        when (val demoted = callFor(summary, userId, first, unchangedIsDone = true, before = { over -> requireBound(over); stagedOver = over },
            beforeKept = ::link) { revision, kems ->
            // The member list version this demotion takes if it lands (the core's next roster: its entry's since), kept before
            // it is staged. Never the chain's revision, which a standalone succession moves past the member list's version.
            removal = removal.copy(demoted = removal.confirmed?.demotedAt(stagedOver!!.rosterVersion.toLong() + 1))
            outbox.keepRemoval(this.userId, groupId, removal)
            ledger.rolesBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, revision, userId, MembersRole.TAKE, kems)
        }) {
            RoleEnd.Landed -> {}
            is RoleEnd.Pending -> return RemovalEnd.Pending(keptForLater(family))
            // A refusal that said nothing definite (the family couldn't be checked, kept changing) waits for the next open.
            is RoleEnd.Refused -> return if (demoted.retry) RemovalEnd.Pending(keptForLater(family)) else RemovalEnd.Failed(demoted.words)
            is RoleEnd.Waiting -> return RemovalEnd.Pending(keptForLater(family))
            RoleEnd.CheckFirst -> return RemovalEnd.Failed("Nothing was changed.")
            RoleEnd.Wiped -> return RemovalEnd.Wiped
        }
        // Read again: the view from before would still say they manage the family.
        syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
        if (!inFamily(view!!, userId)) return RemovalEnd.Changed
        requireBound(view!!)
    }

    onStep(RemovalStep.HOLD)
    val placed = placeHold(summary, userId, view!!)
    if (placed != null) return placed

    // Finish: a walk running in a folder would make the removal answer `rotating`, and one that re-keyed anything can't be
    // taken over. Said as a step only when one was running.
    syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
    if (!inFamily(view!!, userId)) return RemovalEnd.Changed
    requireBound(view!!)
    var finishing = false
    for (area in view!!.areas) {
        val running = area.rotation ?: continue
        // A run whose fields didn't read is walked by nobody: the server's `rotating` answer names it in full, and the outbox walks it then.
        if (running.nodeId.isEmpty()) continue
        if (!finishing) onStep(RemovalStep.FINISH)
        finishing = true
        // Placed again before each folder's walk: walks of large folders add up past the hold's 15 minutes.
        placeHold(summary, userId, view!!)?.let { return it }
        walk(groupId, WalkTarget(area.workspaceId, running.id, running.nodeId, running.targetEpoch))
    }

    onStep(RemovalStep.REMOVE)
    repeat(MAX_REBUILDS) {
        // Placed again right before the folders are read: a long finish must not let it lapse while the epochs are drawn.
        placeHold(summary, userId, view!!)?.let { return it }
        val sent = rotatingCall(summary, named, ::link) { signedOver, revision, kems ->
            if (!inFamily(signedOver, userId)) throw NotConfirmed(present = false)
            requireBound(signedOver)
            ledger.removalBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, revision, userId, gatherLive(groupId), endsLapsed,
                vault.accountKeyVersion(), kems)
        }
        val end = when (sent) {
            is Rotated.Refused -> return if (sent.retry) RemovalEnd.Pending(sent.words) else RemovalEnd.Failed(sent.words)
            Rotated.Wiped -> return RemovalEnd.Wiped
            Rotated.Waiting -> return RemovalEnd.Pending(keptForLater(family))
            is Rotated.Sent -> sent
        }
        when (val call = end.end) {
            CallEnd.Landed -> return RemovalEnd.Removed
            is CallEnd.Pending -> return RemovalEnd.Pending(keptForLater(family))
            CallEnd.Wiped -> return RemovalEnd.Wiped
            CallEnd.OtherKeys, CallEnd.Other -> return RemovalEnd.Failed("Nothing was changed.")
            // Another manager's change landed first: built again over it.
            CallEnd.Stale -> {}
            is CallEnd.Refused -> when (call.code) {
                "left-due" -> {
                    // Marked left first (every folder rotated), then the removal again; if they left meanwhile, marking them
                    // left is the whole removal. Not marked over a change kept unresolved (the staging gate): the removal is
                    // pending, its intent kept, and goes on at the next open.
                    val departed = leftDue(call.data)
                    when (val marked = markDepartedLeft(summary, departed, named, ::link)) {
                        is Rotated.Sent -> if (marked.end != CallEnd.Landed) return when (val m = marked.end) {
                            is CallEnd.Pending -> RemovalEnd.Pending(keptForLater(family))
                            // Another departure to mark first, or a plan busy for a moment: goes on at the next open.
                            is CallEnd.Refused -> if (removalGoesOn(m.code)) RemovalEnd.Pending(keptForLater(family)) else RemovalEnd.Failed(m.words)
                            CallEnd.Wiped -> RemovalEnd.Wiped
                            // Overtaken, or held: nothing definite about the removal; it goes on at the next open.
                            else -> RemovalEnd.Pending(keptForLater(family))
                        }
                        is Rotated.Refused -> return if (marked.retry) RemovalEnd.Pending(marked.words) else RemovalEnd.Failed(marked.words)
                        Rotated.Wiped -> return RemovalEnd.Wiped
                        Rotated.Waiting -> return RemovalEnd.Pending(keptForLater(family))
                    }
                    if (departed.any { it.equals(userId, ignoreCase = true) }) return RemovalEnd.Removed
                }
                "busy" -> return RemovalEnd.Pending(keptForLater(family))
                "members-changed" -> return membersChanged(summary, userId)
                "ends-lapsed" -> return RemovalEnd.EndsLapsed(FamilyLapsedPlan.listIn(call.data))
                else -> return RemovalEnd.Failed(call.words)
            }
        }
        syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
        if (!inFamily(view!!, userId)) return RemovalEnd.Removed
        requireBound(view!!)
    }
    return RemovalEnd.Pending("$family kept changing. Try again in a moment.")
}

/* The hold placed (or placed again); null when it holds, else what the removal says instead. */
private fun FamilySync.placeHold(summary: GroupSummary, userId: String, view: FamilyView): RemovalEnd? = try {
    api.hold(summary.id, userId)
    null
} catch (error: GroupsApiError) {
    when (error.code) {
        "held" -> RemovalEnd.Held(whoHolds(summary.id), manages(view, userId))
        "members-changed" -> membersChanged(summary, userId)
        else -> when {
            error.isNotMember -> throw error
            // No answer, or the server's for now (a timeout, throttling, an outage): the removal goes on at the next open.
            error.status == 0 || error.status == 408 || error.status == 429 || error.status >= 500 -> RemovalEnd.Pending(keptForLater(summary.name))
            else -> RemovalEnd.Failed(callWords(CallAnswer(error.status, error.code, null, error.message), null, summary.name))
        }
    }
}

/*
 * The server's `members-changed`, said as what the family is now (read again, so the page shows it too): the account let go
 * of (not-member) is Wiped, the person no longer in it is Changed, and anything else (still in, or a read that didn't answer)
 * is Moved, never "no longer in the family" about someone who is.
 */
private fun FamilySync.membersChanged(summary: GroupSummary, userId: String): RemovalEnd = when (val state = syncRevised(summary).state) {
    FamilyState.Wiped -> RemovalEnd.Wiped
    is FamilyState.Accepted -> if (inFamily(state.view, userId)) RemovalEnd.Moved else RemovalEnd.Changed
    else -> RemovalEnd.Moved
}

/* Who holds this manager, from route 3's `due.holds` (listed to every holder); null when unknown: nobody is named on a guess. */
private fun FamilySync.whoHolds(groupId: String): String? = try {
    val mine = api.group(groupId).due?.holds.orEmpty().filter { it.userId.equals(userId, ignoreCase = true) }
    mine.singleOrNull()?.heldBy
} catch (error: Exception) {
    // Not-member is the account's removal (notMemberLetsGo wipes), and a lost session is lost; any other failure only
    // leaves the holder unnamed.
    if (error is NotAuthenticated || (error is GroupsApiError && error.isNotMember)) throw error
    null
}

/* The departures a 409 left-due names. */
private fun leftDue(data: JSONObject?): List<String> =
    data?.optJSONArray("userIds")?.let { list -> (0 until list.length()).mapNotNull { list.optString(it).lowercase().takeIf(FamilyRecords::valid) } }.orEmpty()

/*
 * Marking the departed left (route 7; the web's markDepartedLeft): a 409 left-due, or route 3's `due.markLeft`. Every live
 * folder rotated (a family roster that marks anyone left must), with the succession when one managed the family.
 */
internal fun FamilySync.markDepartedLeft(summary: GroupSummary, userIds: List<String>, names: (String) -> String? = { null },
    beforeKept: (String) -> Unit = {}): Rotated =
    rotatingCall(summary, names, beforeKept) { _, revision, kems ->
        ledger.markLeftBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, userIds.map { it.lowercase() },
            gatherLive(summary.id), vault.accountKeyVersion(), kems)
    }

/* What a folder's deletion or key replacement came to. */
sealed interface FolderEnd {
    data object Landed : FolderEnd
    data class Pending(val words: String) : FolderEnd
    data class Refused(val words: String) : FolderEnd
    data object Wiped : FolderEnd
}

/*
 * Delete family folder (the web's deleteFamilyFolder, groups design 2.10): the folder's tombstone on the member list, its own
 * change, kept and sent. A deletion of it kept unanswered goes first; another manager's change (`stale`) is built over.
 */
fun FamilySync.deleteFolder(summary: GroupSummary, workspaceId: String): FolderEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { FolderEnd.Wiped }) {
        val ws = workspaceId.lowercase()
        for (kept in outbox.list(userId, summary.id)) {
            when (val end = sendKept(summary, kept, only = ChainRoute.Delete(ws))) {
                CallEnd.Other, CallEnd.Stale -> {}
                else -> return@notMemberLetsGo folderEnd(end, summary.name) ?: FolderEnd.Landed
            }
        }
        repeat(3) {
            when (val sent = rotatingCall(summary, { null }) { _, revision, kems ->
                ledger.areaDeleteBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, ws, kems)
            }) {
                is Rotated.Refused -> return@notMemberLetsGo FolderEnd.Refused(sent.words)
                Rotated.Wiped -> return@notMemberLetsGo FolderEnd.Wiped
                Rotated.Waiting -> return@notMemberLetsGo FolderEnd.Refused(earlierWaiting(summary.name))
                is Rotated.Sent -> if (sent.end != CallEnd.Stale) return@notMemberLetsGo folderEnd(sent.end, summary.name) ?: FolderEnd.Landed
            }
        }
        FolderEnd.Refused("${summary.name} keeps changing. Try again in a moment.")
    }
}

/* A sent call's end as a folder change says it; null for landed. */
private fun folderEnd(end: CallEnd, family: String): FolderEnd? = when (end) {
    CallEnd.Landed -> null
    is CallEnd.Pending -> FolderEnd.Pending(end.reason)
    is CallEnd.Refused -> FolderEnd.Refused(end.words)
    CallEnd.Wiped -> FolderEnd.Wiped
    CallEnd.Stale -> FolderEnd.Refused("$family changed while you were working on it. Try again.")
    CallEnd.OtherKeys, CallEnd.Other -> FolderEnd.Refused("Nothing was changed.")
}

/*
 * A folder's key replacement (route 24; the web's replaceKeys): a new key for the folder on the member list, its top folder
 * re-keyed and its documents sealed again in the same call, then walked in the background like a removal's. What route 3's
 * `due.rotations` asks of a manager (a share or link stopped in the folder).
 */
internal fun FamilySync.replaceKeys(summary: GroupSummary, workspaceId: String): Rotated = rotatingCall(summary, { null }) { _, revision, kems ->
    ledger.areaRotationBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, gather(summary.id, workspaceId, folderKinds(null, workspaceId)),
        vault.accountKeyVersion(), kems)
}

/*
 * A family folder whose previous top-folder key doesn't open with its current key while its walk runs: one this phone held
 * itself is put again (route 28; the web's repairPreviousRoots), so a member given only the new key reads what the walk
 * hasn't reached. The core decides from route 25's root, and never from a key a served envelope gave.
 */
internal fun FamilySync.repairPreviousRoots(summary: GroupSummary, view: FamilyView): Int {
    var repaired = 0
    for (area in view.areas) {
        val rotation = area.rotation?.takeIf { it.id != null } ?: continue
        val root = area.root ?: continue
        val raw = runCatching { JSONObject(root.rawJson) }.getOrNull() ?: continue
        val previous = raw.optString("prevKeyEnvelope").ifEmpty { null } ?: continue
        fun epoch(key: String) = if (raw.isNull(key) || !raw.has(key)) null else raw.optLong(key, -1L).takeIf { it >= 0 }?.toULong()
        val checked = ledger.previousRootRepair(summary.id, area.workspaceId, PreviousRoot(root.id, root.parentKeyEpoch,
            runCatching { base64urlDecode(previous) }.getOrNull(), epoch("prevKeyEpoch"), epoch("prevParentKeyEpoch")))
        if (checked !is PreviousRootRepair.Repair) continue
        api.putPreviousRoot(summary.id, area.workspaceId, rotation.id!!, base64urlEncode(checked.previousRootKeyEnvelope))
        repaired++
    }
    return repaired
}

/*
 * What a manager's due work did, for the page: the departed marked left, folders given new keys, keys repaired, what to say,
 * and whether it waited (`deferred`) for changes kept unanswered on this phone.
 */
data class DueDone(val markedLeft: Boolean = false, val rotated: Int = 0, val repaired: Int = 0, val said: List<String> = emptyList(), val deferred: Boolean = false)

/*
 * What route 3 says is due, done by a manager's device at each open of the family (the web's runDue, its manager half):
 * the departed marked left, folders owed new keys given them, and a previous top-folder key repaired. Each step reads route
 * 3 again, since the one before may have cleared it. A refusal is said; what was kept unanswered goes at the next open.
 */
fun FamilySync.runDue(summary: GroupSummary, names: (String) -> String? = { null }): DueDone = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { DueDone() }) {
        // Nothing is staged over a change kept unresolved (the staging gate): due work then waits for the next open.
        val said = ArrayList<String>()
        var due = api.group(summary.id).due ?: return@notMemberLetsGo DueDone()
        var marked = false
        if (due.markLeft.isNotEmpty()) {
            when (val sent = markDepartedLeft(summary, due.markLeft, names)) {
                is Rotated.Sent -> when (val end = sent.end) {
                    CallEnd.Landed -> marked = true
                    is CallEnd.Refused -> said += end.words
                    CallEnd.Wiped -> return@notMemberLetsGo DueDone()
                    else -> {}
                }
                is Rotated.Refused -> said += sent.words
                Rotated.Wiped -> return@notMemberLetsGo DueDone()
                Rotated.Waiting -> return@notMemberLetsGo DueDone(said = said, deferred = true)
            }
            due = api.group(summary.id).due ?: due
        }
        var rotated = 0
        for (workspaceId in due.rotations) {
            when (val sent = replaceKeys(summary, workspaceId)) {
                is Rotated.Sent -> when (val end = sent.end) {
                    CallEnd.Landed -> rotated++
                    is CallEnd.Refused -> said += end.words
                    CallEnd.Wiped -> return@notMemberLetsGo DueDone()
                    else -> {}
                }
                is Rotated.Refused -> said += sent.words
                Rotated.Wiped -> return@notMemberLetsGo DueDone()
                Rotated.Waiting -> return@notMemberLetsGo DueDone(marked, rotated, said = said, deferred = true)
            }
        }
        val view = (syncRevised(summary).state as? FamilyState.Accepted)?.view
        val repaired = view?.let { repairPreviousRoots(summary, it) } ?: 0
        DueDone(marked, rotated, repaired, said)
    }
}
