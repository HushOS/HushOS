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
 * epoch drawn after it was read (above every epoch the folder carries), and every workspace document of the kinds this
 * client knows and of `kinds` (a 409 document-stale names them). Read again for every rebuild, never kept. Shares and links
 * are never handed on: nothing records who made them in a family folder, so the rotation closes them (the web does too).
 */
internal fun FamilySync.gather(groupId: String, workspaceId: String, kinds: Collection<String> = emptyList()): AreaRotation {
    val ws = workspaceId.lowercase()
    val served = api.areaRoot(groupId, ws)
    val target = vault.drawFamilyEpoch(ws)
    val documents = (DOCUMENT_KINDS + kinds.filter(KIND::matches)).toSortedSet().mapNotNull { kind ->
        vault.api.document(ws, kind)?.let { (envelope, version) -> ServedDocument(kind, version.toULong(), base64urlDecode(envelope)) }
    }
    val node = served.node
    // As a walk takes the top folder, then put under the folder's next key version (the worker checks it against the roster).
    val root = rotating(served, node.id, target, ws).copy(parentKeyEpoch = node.parentKeyEpoch + 1uL, shareIds = emptyList(), linkIds = emptyList())
    return AreaRotation(ws, target, root, (node.changeSeq ?: 0).toULong(), documents)
}

/* Every live family folder gathered: what a removal or marking someone left rotates. */
private fun FamilySync.gatherLive(groupId: String): List<AreaRotation> =
    (liveAreas(groupId) ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)).map { gather(groupId, it) }

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
    return Rebuilt.Kept(rebuildWith(summary.id, kept, areas.map { (ws, kinds) -> gather(groupId, ws, kinds) }))
}

/*
 * The kept call's rotations of `rotations`' folders made again by the core, kept over the old entry under the same id.
 * Documents that didn't open are read again once and the rotations of their folders made again (the server may have served
 * junk to this device alone; the web's refetchReplaced); whatever still doesn't open is noted beside the entry, and said
 * once the call lands, whichever open sends it.
 */
private fun FamilySync.rebuildWith(groupId: String, kept: FamilyOutbox.Kept, rotations: List<AreaRotation>): FamilyOutbox.Kept {
    val first = ledger.outboxRebuild(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, kept.outboxId, kept.entry, rotations)
    // Marked for its read-again before the rebuilt entry is kept: an entry that carries documents on empty is never sendable unchecked.
    outbox.markRecheck(userId, groupId, first.outboxId, first.replaced)
    outbox.put(userId, groupId, first.outboxId, first.entry)
    return readAgain(groupId, FamilyOutbox.Kept(first.outboxId, first.entry), first.replaced)
}

/*
 * `replaced` read again once (their folders gathered with those kinds) and the call rebuilt. In this order, each durable before
 * the next: what still didn't open noted beside the entry, the rebuilt entry kept, and only then its recheck marker gone, so a
 * failure or a killed process anywhere leaves it marked, and the next send reads again first.
 */
internal fun FamilySync.readAgain(groupId: String, kept: FamilyOutbox.Kept, replaced: List<ReplacedDocument>): FamilyOutbox.Kept {
    if (replaced.isEmpty()) return kept
    val again = replaced.groupBy({ it.workspaceId.lowercase() }, { it.kind }).map { (ws, kinds) -> gather(groupId, ws, kinds) }
    val call = ledger.outboxRebuild(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, kept.outboxId, kept.entry, again)
    outbox.noteCleared(userId, groupId, call.outboxId, call.replaced.map { it.kind })
    outbox.put(userId, groupId, call.outboxId, call.entry)
    outbox.clearRecheck(userId, groupId, call.outboxId)
    return FamilyOutbox.Kept(call.outboxId, call.entry)
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
private fun FamilySync.rotatingCall(summary: GroupSummary, names: (String) -> String?, build: (FamilyView, ULong, Map<String, String>) -> RosterCall): Rotated =
    when (val staged = stageCall(summary, build)) {
        is Staged.Call -> Rotated.Sent(sendKept(summary, readAgain(summary.id, staged.kept, staged.replaced), names = names))
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
    /* Kept on this phone and sent again at the next open. */
    data class Pending(val words: String) : RemovalEnd
    data class Failed(val words: String) : RemovalEnd
    data object Wiped : RemovalEnd
    /* Plans they pay for that give nothing end with the removal: asked first, nothing changed. */
    data class EndsLapsed(val plans: List<FamilyLapsedPlan>) : RemovalEnd
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
fun FamilySync.removeMember(summary: GroupSummary, userId: String, first: String, demoteFirst: Boolean = false, endsLapsed: List<String> = emptyList(),
    names: (String) -> String? = { null }, onStep: (RemovalStep) -> Unit = {}): RemovalEnd = exclusive(summary.id) {
    notMemberLetsGo(summary.id, { RemovalEnd.Wiped }) { removeKept(summary, FamilyOutbox.Removal(userId.lowercase(), first, endsLapsed, demoteFirst), names, onStep) }
}

/*
 * One removal's turn, its intent kept on this device while it runs (removeInTurn keeps it once the plans are confirmed) and
 * dropped at a definite end; a pending end (a departure still to mark left, a demotion or the removal unanswered, a change
 * kept before it) keeps it, and the next open goes on with it (continueRemovals).
 */
private fun FamilySync.removeKept(summary: GroupSummary, removal: FamilyOutbox.Removal, names: (String) -> String?, onStep: (RemovalStep) -> Unit): RemovalEnd {
    val end = removeInTurn(summary, removal.userId, removal.first, removal.demote, removal.endsLapsed, names, onStep)
    if (end !is RemovalEnd.Pending) outbox.dropRemoval(userId, summary.id, removal.userId)
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

private fun FamilySync.removeInTurn(summary: GroupSummary, userId: String, first: String, demoteFirst: Boolean, endsLapsed: List<String>,
    names: (String) -> String?, onStep: (RemovalStep) -> Unit): RemovalEnd {
    val groupId = summary.id
    val family = summary.name
    val named = { id: String -> if (id.equals(userId, ignoreCase = true)) first else names(id) }
    // A removal of them kept unanswered (a lock, a kill, no answer) goes first: never a second one signed beside it.
    for (kept in outbox.list(this.userId, groupId)) {
        when (val end = sendKept(summary, kept, only = ChainRoute.Remove(userId, emptyList()), names = named)) {
            CallEnd.Other, CallEnd.Stale -> {}
            CallEnd.Landed -> {
                val (view, stop) = syncedView(summary)
                if (view == null) return stop!!
                if (!inFamily(view, userId)) return RemovalEnd.Removed
            }
            is CallEnd.Pending -> return RemovalEnd.Pending(keptForLater(family))
            // Refused as kept: a departure still to mark left is done below (staged anew); the rest is definite.
            is CallEnd.Refused -> when (end.code) {
                "left-due" -> {}
                "members-changed" -> return RemovalEnd.Changed
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
    // Asked first, before anything changes: the plans they pay for that give nothing, which removing them ends. One not
    // confirmed yet stops here; one that can't be ended is said in the server's words.
    val plans = try {
        api.removalPreview(groupId, userId)
    } catch (error: GroupsApiError) {
        if (error.code == "payer") return RemovalEnd.Failed(error.message ?: error.words)
        throw error
    }
    if (plans.any { it.id !in endsLapsed }) return RemovalEnd.EndsLapsed(plans)
    // Confirmed: from here the removal is a promise kept on this device until it ends (removeKept, continueRemovals).
    outbox.keepRemoval(this.userId, groupId, FamilyOutbox.Removal(userId, first, endsLapsed, demoteFirst))

    if (demoteFirst && manages(view, userId)) {
        onStep(RemovalStep.DEMOTE)
        when (val demoted = callFor(summary, userId, first, unchangedIsDone = true) { revision, kems ->
            ledger.rolesBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), groupId, revision, userId, MembersRole.TAKE, kems)
        }) {
            RoleEnd.Landed -> {}
            is RoleEnd.Pending -> return RemovalEnd.Pending(keptForLater(family))
            is RoleEnd.Refused -> return RemovalEnd.Failed(demoted.words)
            is RoleEnd.Waiting -> return RemovalEnd.Pending(keptForLater(family))
            RoleEnd.CheckFirst -> return RemovalEnd.Failed("Nothing was changed.")
            RoleEnd.Wiped -> return RemovalEnd.Wiped
        }
        // Read again: the view from before would still say they manage the family.
        syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
    }

    onStep(RemovalStep.HOLD)
    val placed = placeHold(summary, userId, view!!)
    if (placed != null) return placed

    // Finish: a walk running in a folder would make the removal answer `rotating`, and one that re-keyed anything can't be
    // taken over. Said as a step only when one was running.
    syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
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
        val sent = rotatingCall(summary, named) { _, revision, kems ->
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
                    when (val marked = markDepartedLeft(summary, departed, named)) {
                        is Rotated.Sent -> if (marked.end != CallEnd.Landed) return when (val m = marked.end) {
                            is CallEnd.Pending -> RemovalEnd.Pending(keptForLater(family))
                            is CallEnd.Refused -> RemovalEnd.Failed(m.words)
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
                "members-changed" -> return RemovalEnd.Changed
                "ends-lapsed" -> return RemovalEnd.EndsLapsed(FamilyLapsedPlan.listIn(call.data))
                else -> return RemovalEnd.Failed(call.words)
            }
        }
        syncedView(summary).let { (now, stopped) -> view = now ?: return stopped!! }
        if (!inFamily(view!!, userId)) return RemovalEnd.Removed
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
        "members-changed" -> { runCatching { syncRevised(summary) }; RemovalEnd.Changed }
        else -> when {
            error.isNotMember -> throw error
            // No answer, or the server's for now (a timeout, throttling, an outage): the removal goes on at the next open.
            error.status == 0 || error.status == 408 || error.status == 429 || error.status >= 500 -> RemovalEnd.Pending(keptForLater(summary.name))
            else -> RemovalEnd.Failed(callWords(CallAnswer(error.status, error.code, null, error.message), null, summary.name))
        }
    }
}

/* Who holds this manager, from route 3's `due.holds` (listed to every holder); null when unknown: nobody is named on a guess. */
private fun FamilySync.whoHolds(groupId: String): String? = runCatching {
    val mine = api.group(groupId).due?.holds.orEmpty().filter { it.userId.equals(userId, ignoreCase = true) }
    mine.singleOrNull()?.heldBy
}.getOrNull()

/* The departures a 409 left-due names. */
private fun leftDue(data: JSONObject?): List<String> =
    data?.optJSONArray("userIds")?.let { list -> (0 until list.length()).mapNotNull { list.optString(it).lowercase().takeIf(FamilyRecords::valid) } }.orEmpty()

/*
 * Marking the departed left (route 7; the web's markDepartedLeft): a 409 left-due, or route 3's `due.markLeft`. Every live
 * folder rotated (a family roster that marks anyone left must), with the succession when one managed the family.
 */
internal fun FamilySync.markDepartedLeft(summary: GroupSummary, userIds: List<String>, names: (String) -> String? = { null }): Rotated =
    rotatingCall(summary, names) { _, revision, kems ->
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
    ledger.areaRotationBody(vault.ownIdentities(), Auth.identity(vault.context, vault.api.session), summary.id, revision, gather(summary.id, workspaceId),
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
