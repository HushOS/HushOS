package com.hushos.app.data

import com.hushos.core.AcceptedRosters
import com.hushos.core.AreaBlock
import com.hushos.core.CoreException
import com.hushos.core.FamilyChecked
import com.hushos.core.ForkOf
import com.hushos.core.GroupIntegrity
import com.hushos.core.GroupPin
import com.hushos.core.GroupRole
import com.hushos.core.GroupVerdict
import com.hushos.core.GroupWriter
import com.hushos.core.Integrity
import com.hushos.core.IdKind
import com.hushos.core.MarkSide
import com.hushos.core.MarkSource
import com.hushos.core.MemberStatus
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.OpenedArea
import com.hushos.core.PinKeys
import com.hushos.core.PinMerge
import com.hushos.core.RecordReader
import com.hushos.core.RecordStatement
import com.hushos.core.RecordVerdict
import com.hushos.core.RosterMember
import com.hushos.core.ServedAcceptance
import com.hushos.core.ServedArea
import com.hushos.core.ServedAreaGrant
import com.hushos.core.ServedChain
import com.hushos.core.ServedOrigin
import com.hushos.core.ServedRecord
import com.hushos.core.ServedRekey
import com.hushos.core.SignedGroupStatement
import com.hushos.core.SignerHistory
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.WriterPin
import com.hushos.core.areaWriteVersion
import com.hushos.core.base64urlDecode
import com.hushos.core.checkId
import com.hushos.core.digestHex
import com.hushos.core.keyCommitment
import com.hushos.core.mergePin
import com.hushos.core.pinAhead
import com.hushos.core.servedRaceMessage
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock

/*
 * Syncing one family on this phone (docs/groups-mobile-plan.md, Android 1; iOS's FamilySync.swift, the web's
 * lib/groups/sync.ts and pins.ts): the member list from route 5, accepted by the core's area ledger against this person's
 * marks (the device record, the settings pin, the family guard and the chain committed this session); the guard the
 * acceptance hands back stored first, then the record, never over one at a later roster version; every family folder
 * from route 25 opened from its grant and its top folder listed through the ledger; and only then the settings pin
 * brought up to the acceptance with the folders just opened. Every rule is the core's; this file fetches, stores and
 * keeps the order, one family at a time (a second sync of the same family waits for the first).
 */

/* Whether a family folder could be written on this device, as the web words it (sync.ts areaWrite). */
enum class AreaWrite { WRITABLE, READ_ONLY, KEYS_CHANGED }

/* One family folder, as this device opened it. */
data class FamilyArea(
    val workspaceId: String,
    /* From the top folder's sealed metadata; null when it did not open. */
    val name: String? = null, val root: NodeView? = null,
    /* The folder's key opened from a grant the member list vouches for. */
    val opened: Boolean = false,
    /* Its top folder opened through the ledger at the member list's latest key version. */
    val rootListed: Boolean = false,
    /* The key change route 25 says is running in it (a removal's, a departure's), if any. */
    val rotation: SpaceRotation? = null, val write: AreaWrite = AreaWrite.READ_ONLY,
) {
    val openable: Boolean get() = opened && root != null && name != null
    val rotating: Boolean get() = rotation != null

    /* What its row says under its name, in the web's words (s/$groupId/index.tsx, areaLine). */
    val line: String get() = when {
        !openable -> "Couldn’t check this folder’s keys"
        write == AreaWrite.READ_ONLY -> "Open only: its keys couldn’t be checked here"
        write == AreaWrite.KEYS_CHANGED -> "Its keys changed. Open it to check again."
        rotating -> "Finishing a key change…"
        else -> "Everyone in the family can open it"
    }
}

/* A member as the accepted member list names them: roles are the list's, names come from route 3. */
data class FamilyMember(val userId: String, val roles: List<String>, val commitment: String?)

/* Folders this family's member list names that aren't its own (the ledger's foreign_listings), one notice per owner. */
data class ForeignNotice(val owner: String?, val count: Int) {
    fun title(family: String) = when {
        owner == null -> "$family’s member list names your own files"
        count == 1 -> "$family’s member list names a folder that isn’t its own"
        else -> "$family’s member list names folders that aren’t its own"
    }

    fun body(family: String, familyOf: (String) -> String?): String {
        val them = if (count == 1 && owner != null) "it" else "them"
        val what = owner?.let { "${if (count == 1) "one" else count.toString()} of ${familyOf(it) ?: "another family"}’s folders" } ?: "your own files, in My files"
        return listOf("It names $what.", "HushOS ignored that, so nothing in $them was shared or changed.",
            "Someone who manages, or managed, $family signed it, and the server accepted it.",
            "A member list keeps everything it names, so this notice stays.", "Tell the other members of $family.").joinToString(" ")
    }
}

data class FamilyView(
    val groupId: String, val rosterVersion: ULong, val rosterDigest: String, val groupKeyVersion: ULong,
    val members: List<FamilyMember>, val areas: List<FamilyArea>,
    /* This device's saved check didn't open and the family was checked from the start. */
    val recordReset: Boolean,
    /* A roster named keys that aren't this account's for its entry. */
    val ownEntryWrong: Boolean,
    /* The member list still names this account's previous keys: a note, not a warning. */
    val ownEntryBehind: Boolean,
    val foreign: List<ForeignNotice>,
)

/* The hard warning's technical details: what was shown differently, at which version, and where each side came from. */
data class FamilyFork(val memberList: Boolean, val version: ULong, val sides: List<Side>) {
    data class Side(val digest: String, val from: List<String>)
}

sealed interface FamilyState {
    /* Accepted the invitation, not let in yet. */
    data object Waiting : FamilyState
    /* Nothing on this device or in the account's settings checked the family: only joining can start it. */
    data object Unchecked : FamilyState
    data class Accepted(val view: FamilyView) : FamilyState
    /* The member list was shown differently to this person: nothing opens. */
    data class Fork(val fork: FamilyFork) : FamilyState
    /* The server said this account is not in the family: what the phone kept of it is gone. */
    data object Wiped : FamilyState
    /*
     * Couldn't check, in FamilyWords' words. `transient`: the failure was the network's or the server's for now (no answer,
     * 408, 429, 5xx), so a retry may pass. `removal`: the server said this account is not in the family, but this phone
     * couldn't let go of it yet (its guard not stored or read); the family is refused meanwhile.
     */
    data class Failed(val words: String, val transient: Boolean = false, val removal: Boolean = false) : FamilyState
}

class FamilySync(
    internal val vault: Vault,
    internal val api: GroupsApi = GroupsApi(vault.api.session),
    records: FamilyRecords = FamilyRecords.of(vault.context),
    internal val now: () -> Instant = { Instant.now() },
) {
    // Bound to this vault's session: once it is closed, nothing it does writes or deletes a record.
    internal val records: FamilyRecords = records.whileOpen { !vault.closed }
    private val turns = ConcurrentHashMap<String, ReentrantLock>()
    /* Families accepted in this process (and not refused, forked or wiped since): whose proven folders' copies may stay. */
    private val accepted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val details = ConcurrentHashMap<String, GroupDetail>()
    private val identities = ConcurrentHashMap<String, Map<String, MemberIdentity>>()
    private val names = ConcurrentHashMap<String, String>()
    private val areasOf = ConcurrentHashMap<String, List<String>>()
    /* Every family folder this process learned of, to its family: never forgotten in a session. */
    private val groupsOf = ConcurrentHashMap<String, String>()
    /* Whether this person vouched for each family (Settings.familyChecked), read after every accepted sync. */
    internal val vouched = ConcurrentHashMap<String, Boolean>()
    /* Each family's chain as this process last committed it: the pair code is worked out over it. */
    private val chains = ConcurrentHashMap<String, AcceptedRosters>()
    /* Families whose last refusal was a fork (lowercase): a later refusal keeps the core's fork. A commit clears it. */
    private val forked: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /* Families route 2 stopped listing that this session wiped on the server's not-member: not asked about again unless listed again. */
    private val settledUnlisted: MutableSet<String> = ConcurrentHashMap.newKeySet()

    internal val ledger get() = vault.areaLedger
    internal val userId get() = vault.familyUserId

    /* Route 2: the families whose ids are ids (a server's other strings never reach a path or a file name). */
    fun list(): List<GroupSummary> = api.listGroups().filter { FamilyRecords.valid(it.id) }.onEach { names[it.id] = it.name }

    /*
     * Route 2, and every family this phone holds (a device record, or a chain accepted this session) that it no longer
     * lists asked about once (route 5 from the record's version): only the server's 404 `not-member` wipes one. A family
     * still served (route 2 caught between two states) or no answer changes nothing; a list that didn't load throws here
     * and nothing is unlisted. The wiped families come back beside the list, and so does one whose wipe couldn't finish
     * (its guard not stored or read): refused, nothing of it open, its words said, and asked again on the next list.
     */
    fun listReconciling(): Pair<List<GroupSummary>, List<Revised>> {
        val listed = list()
        val shown = listed.map { it.id.lowercase() }.toSet()
        settledUnlisted.removeAll(shown)
        val held = (records.groups(userId) + groupsOf.values.map { it.lowercase() }).toSet() - settledUnlisted - shown
        // Each removal with the revision it took inside the family's turn: an answer from before it never shows after it.
        val wiped = held.sorted().filter(FamilyRecords::valid).mapNotNull { id ->
            exclusive(id) { askUnlisted(id)?.let { Revised(it, revise(), id) } }
        }
        // Kept for whoever draws the families (FamiliesModel), whichever caller found them: the background work using
        // the app's vault finds a removal as surely as the app does, and the screens must let go of it too.
        publishRemovals(wiped)
        return listed to wiped
    }

    /* Whether a sync's state let go of what was open of the family (refuse or wipe ran): everything but accepted and no answer. */
    private fun letGo(state: FamilyState): Boolean = when (state) {
        is FamilyState.Accepted -> false
        is FamilyState.Failed -> state.words != FamilyWords.NO_ANSWER
        else -> true
    }

    /*
     * Every wipe of a family, whoever ran it (a sync's not-member, route 2's reconciliation, a member check, a join, a
     * leave), queued for the screens and told: the background work shares the app's vault and must not leave them drawing
     * what it let go of. A wipe that couldn't finish goes too, as the refusal it leaves.
     */
    internal fun publishRemovals(found: List<Revised>) {
        if (found.isEmpty()) return
        removals.addAll(found)
        onRemovals?.invoke()
    }

    /* Removals and unfinished wipes found by any caller of listReconciling, until the screens take them. */
    private val removals = java.util.concurrent.ConcurrentLinkedQueue<Revised>()
    /* Told when a caller found some (the background work, say); the screens then take them. */
    @Volatile var onRemovals: (() -> Unit)? = null

    /* The removals found since the last call, each once, in the order found. */
    fun takeRemovals(): List<Revised> = generateSequence { removals.poll() }.toList()

    /*
     * Families this phone still keeps a device record of that `listed` doesn't name: a removal not settled yet (the
     * server's not-member never came, or the wipe couldn't finish). Only a confirmed not-member lets go of one, so until
     * this is empty the background check stays scheduled.
     */
    fun unsettled(listed: List<GroupSummary>): List<String> {
        val shown = listed.map { it.id.lowercase() }.toSet()
        return records.groups(userId).filter { it !in shown }
    }

    private fun askUnlisted(groupId: String): FamilyState? {
        val after = records.read(userId, groupId)?.rosterVersion?.toInt() ?: 0
        return try {
            api.rosters(groupId, after)
            // Still served: a list caught mid-change, never a removal.
            null
        } catch (error: GroupsApiError) {
            if (!error.isNotMember) return null
            try {
                wipe(groupId)
            } catch (failed: Exception) {
                // As run()'s removal: the guard (and so the record) kept for the two-phase wipe, but nothing of the family
                // opens. Not settled: the next list asks again, until the wipe finishes.
                refuse(groupId)
                return FamilyState.Failed(FamilyWords.error(failed), removal = true)
            }
            // A closed vault's wipe lets go of nothing (it waits for this session's next look): not settled either.
            if (records.read(userId, groupId) != null) return null
            names.remove(groupId)
            settledUnlisted.add(groupId.lowercase())
            FamilyState.Wiped
        } catch (error: NotAuthenticated) {
            throw error
        } catch (_: Exception) {
            // No answer, any other failure: nothing is taken away.
            null
        }
    }

    /* Route 3 as the last sync read it. */
    fun detail(groupId: String): GroupDetail? = details[groupId]

    /* Route 3 read now (it answers someone who accepted, too): who manages the family, for the wait to name. */
    fun members(groupId: String): GroupDetail = api.group(groupId).also { details[groupId] = it }

    fun openInvitation(token: String): Invitation = api.openInvitation(token)
    fun acceptInvitation(token: String): String = api.acceptInvitation(token)

    /* Every family folder this process knows of, to its family id. */
    fun familyAreas(): Map<String, String> = HashMap(groupsOf)

    private fun note(areas: List<String>, groupId: String) {
        for (area in areas) groupsOf[area.lowercase()] = groupId
        vault.noteFamilyWorkspaces(areas, groupId)
    }

    /* One family synced, after any sync of it already running. */
    fun sync(summary: GroupSummary): FamilyState = syncRevised(summary).state

    /*
     * A sync with the revision it ran at: taken inside the family's turn, so a later revision is a later look at the family
     * whenever it was asked for. What publishes a family's state orders answers by it.
     */
    fun syncRevised(summary: GroupSummary): Revised {
        names[summary.id] = summary.name
        val revised = exclusive(summary.id) { Revised(run(summary), revision.incrementAndGet(), summary.id) }
        // Anything that let go of what was open (a removal finished or not, a fork, an unchecked chain, a rollback or any
        // other refusal): the screens let go of it too, whoever ran the sync. Only an accepted family, or no answer at all
        // (which leaves things as they were), isn't published.
        if (letGo(revised.state)) publishRemovals(listOf(revised))
        return revised
    }

    data class Revised(val state: FamilyState, val revision: Long, val groupId: String? = null)

    /* A revision taken now: called only inside the family's turn, so its order is the order the family was looked at. */
    internal fun revise(): Long = revision.incrementAndGet()
    private val revision = java.util.concurrent.atomic.AtomicLong()

    /* `body` in the family's turn: one piece of work per family at a time (the web's lock); a join step that syncs runs inside its own. */
    internal fun <T> exclusive(groupId: String, body: () -> T): T {
        val lock = turns.getOrPut(groupId.lowercase()) { ReentrantLock() }
        lock.lock()
        try { return body() } finally { lock.unlock() }
    }

    /* One sync's work, inside the family's turn. */
    internal fun run(summary: GroupSummary): FamilyState {
        // The vault's writes into family folders ask this sync for the form records are signed again with.
        vault.familyJudge = this
        val groupId = summary.id
        if (!FamilyRecords.valid(groupId)) return FamilyState.Failed("Please try again.")
        // Accepted but not let in: the join's to finish, never a sync's. A device record means the join finished (a list read before it).
        if (summary.state == "accepted" && records.read(userId, groupId) == null) {
            refuse(groupId)
            return FamilyState.Waiting
        }
        return try {
            vault.prepareLedger()
            var reset = false
            repeat(2) {
                when (val accepted = accept(groupId)) {
                    Acceptance.Unchecked -> { refuse(groupId); return FamilyState.Unchecked }
                    is Acceptance.Forked -> { refuse(groupId, fork = true); return FamilyState.Fork(accepted.fork) }
                    Acceptance.RecordReset -> reset = true
                    is Acceptance.Accepted -> return afterAcceptance(groupId, accepted.chain, accepted.pin, reset)
                }
            }
            throw FamilyFailure("This device’s saved check of the family could not be opened.")
        } catch (error: NotAuthenticated) {
            throw error
        } catch (error: GroupsApiError) {
            if (!error.isNotMember) { forgetUnlessUnanswered(groupId, error); return FamilyState.Failed(FamilyWords.error(error), transient = transient(error)) }
            try {
                wipe(groupId)
                FamilyState.Wiped
            } catch (failed: Exception) {
                // The guard the wipe hands back couldn't be stored (or read): nothing of the family was let go of, but
                // nothing of it opens either.
                refuse(groupId)
                FamilyState.Failed(FamilyWords.error(failed), removal = true)
            }
        } catch (error: Exception) {
            forgetUnlessUnanswered(groupId, error)
            FamilyState.Failed(FamilyWords.error(error), transient = transient(error))
        }
    }

    /* Refused (a rollback, a race that kept losing, keys that didn't check): nothing of the family stays open. No answer leaves it as it was. */
    private fun forgetUnlessUnanswered(groupId: String, error: Throwable) {
        if (!unanswered(error)) refuse(groupId)
    }

    /*
     * Refused (a settings rollback, a fork, a guard that can't be stored, an unchecked chain, keys that didn't check): the
     * core opens and writes nothing of the family until a chain is committed again (the web's uncommit), so no listing
     * reopens its rows through the chain an earlier sync committed, and nothing of it stays open here. A refusal of a
     * family found forked keeps the fork.
     */
    internal fun refuse(groupId: String, fork: Boolean = groupId.lowercase() in forked) {
        if (fork) forked.add(groupId.lowercase())
        accepted.remove(groupId.lowercase())
        ledger.uncommit(groupId, fork)
        chains.remove(groupId)
        vault.forgetWorkspaces(knownAreas(groupId))
        sweepCopies()
    }

    /*
     * The allowlist sweep (Vault.sweepFamilyCopies): only the copies of folders proven this process to belong to a family
     * accepted now stay. Run when this sync starts (before any family download), after every refusal, fork or wipe, and
     * whenever a family's folders change.
     */
    internal fun sweepCopies() {
        val keep = groupsOf.filterValues { it.lowercase() in accepted }.keys
        vault.sweepFamilyCopies(keep)
    }

    init {
        vault.familyJudge = this
        sweepCopies()
    }

    /*
     * What follows a committed acceptance, a sync's or a join's (the web's afterAccept): every family folder opened from
     * its grant, then the settings pin brought up to the acceptance with the folders just opened.
     */
    internal fun afterAcceptance(groupId: String, chain: AcceptedRosters, pin: GroupPin, reset: Boolean): FamilyState {
        val areas = openAreas(groupId, chain)
        return when (val settled = settle(groupId, pin, chain.checked(), areas.mapNotNull { it.second })) {
            is Settled.Forked -> { refuse(groupId, fork = true); FamilyState.Fork(settled.fork) }
            is Settled.Done -> {
                accepted.add(groupId.lowercase())
                // The member list's names: a failure keeps the acceptance, but a not-member here is a removal like any
                // other (the sync's or the join's wipe), never an accepted family with its keys and copies kept.
                try {
                    details[groupId] = api.group(groupId)
                } catch (error: GroupsApiError) {
                    if (error.isNotMember) throw error
                } catch (error: Exception) {
                    if (error is NotAuthenticated) throw error
                }
                // Read with the settings the pin was just saved into: Verified by the family only when this person vouched for it.
                vouched[groupId] = runCatching { vault.loadSettings().familyChecked(groupId) }.getOrDefault(false)
                FamilyState.Accepted(view(groupId, settled.latest ?: chain, areas.map { it.first }, reset))
            }
        }
    }

    /* Whether this person vouched for the family, as the last accepted sync read it. */
    fun familyChecked(groupId: String): Boolean = vouched[groupId] ?: false

    internal fun acceptedChain(groupId: String): AcceptedRosters? = chains[groupId]
    internal fun noteAccepted(groupId: String, chain: AcceptedRosters) {
        chains[groupId] = chain
        forked.remove(groupId.lowercase())
    }

    /*
     * The server said not-member outside a sync (a member check's own roster read): let go of in two phases as a sync's
     * removal is, and Wiped; a guard the wipe can't store leaves the family refused instead.
     */
    internal fun removedNow(groupId: String): Revised = exclusive(groupId) {
        val state = try {
            wipe(groupId)
            FamilyState.Wiped
        } catch (failed: Exception) {
            refuse(groupId)
            FamilyState.Failed(FamilyWords.error(failed), removal = true)
        }
        Revised(state, revision.incrementAndGet(), groupId).also { publishRemovals(listOf(it)) }
    }

    /*
     * Leaving (route 20), then this phone's wipe, as a removal's (the web's LeaveDialog then wipeGroup): the family's keys,
     * its device record, its folders' rows and keys and every copy opened from them go; the settings pin and the family
     * guard stay as marks, so the family coming back is never first use. A refusal (the organizer, the last manager, the
     * payer) or no answer keeps everything. A not-member answer is a leave that already happened: the same wipe.
     */
    fun leave(groupId: String, endsLapsed: List<String> = emptyList()): Leaving {
        if (!FamilyRecords.valid(groupId)) return Leaving.Refused("Please try again.")
        val dissolved = try {
            api.leave(groupId, endsLapsed)
        } catch (error: GroupsApiError) {
            if (error.code == "ends-lapsed" && error.plans.isNotEmpty()) return Leaving.EndsLapsed(error.plans)
            if (!error.isNotMember) return Leaving.Refused(leaveWords(error))
            false
        }
        val removed = removedNow(groupId)
        // Not asked about again from route 2's side (it no longer lists the family) unless it lists it again.
        if (removed.state == FamilyState.Wiped) settledUnlisted.add(groupId.lowercase())
        return Leaving.Left(removed, dissolved)
    }

    sealed interface Leaving {
        /* Left: `removed` is the wipe's outcome (Wiped, or Failed when this phone couldn't let go of everything). */
        data class Left(val removed: Revised, val dissolved: Boolean) : Leaving
        data class Refused(val words: String) : Leaving
        /* Lapsed plans this person pays for end with the leave: said, and confirmed by id on the next press. */
        data class EndsLapsed(val plans: List<FamilyLapsedPlan>) : Leaving
    }

    /* The family folders this process or the device record knows of. */
    internal fun knownAreas(groupId: String): List<String> =
        (groupsOf.filterValues { it == groupId }.keys + areasOf[groupId].orEmpty() + records.read(userId, groupId)?.areas.orEmpty())
            .distinct().filter { ownedBy(it, groupId) }

    /*
     * Whether a family folder may be let go of with `groupId`: never one proven another family's (its id derived under that
     * family, seen this process), whatever a member list or a saved record names. A roster's word alone clears nothing.
     */
    private fun ownedBy(workspaceId: String, groupId: String): Boolean =
        groupsOf[workspaceId.lowercase()]?.equals(groupId, ignoreCase = true) != false &&
            vault.familyOf(workspaceId)?.equals(groupId, ignoreCase = true) != false

    /*
     * The folders a device record keeps for `groupId` after an acceptance: every one it already holds (a folder leaves the
     * record only once its copies are forgotten, in openAreas) and those of the chain's proven this family's.
     */
    internal fun keptAreas(groupId: String, chainAreas: Collection<String>): List<String> =
        (records.read(userId, groupId)?.areas.orEmpty() + provenAreas(groupId, chainAreas)).distinctBy { it.lowercase() }.sorted()

    /* The folders of the chain's proven this family's (opened under it). */
    internal fun provenAreas(groupId: String, chainAreas: Collection<String>): List<String> {
        val proven = (areasOf[groupId].orEmpty() + groupsOf.filterValues { it.equals(groupId, ignoreCase = true) }.keys).map { it.lowercase() }.toSet()
        return chainAreas.filter { it.lowercase() in proven }.sorted()
    }

    // Acceptance

    internal sealed interface Acceptance {
        data object Unchecked : Acceptance
        data class Forked(val fork: FamilyFork) : Acceptance
        data object RecordReset : Acceptance
        class Accepted(val chain: AcceptedRosters, val pin: GroupPin) : Acceptance
    }

    /*
     * One acceptance (the web's acceptServed): the settings read first, so the ledger holds their pin as a mark; the
     * record continued from its roster version; a chain that doesn't continue it fetched again from version 1 with the
     * same record. Overtaken is read again quietly, three times. The family guard goes in as one more mark, read afresh
     * for every call, and the guard an acceptance hands back is stored before anything else of it (2.8). The write
     * barrier goes up before the core commits and comes down only once that guard is stored.
     */
    internal fun accept(groupId: String): Acceptance {
        var overtaken = 0
        while (true) {
            val pinned = vault.familyPin(groupId)
            val row = records.read(userId, groupId)
            if (row == null && pinned == null) return Acceptance.Unchecked
            val me = vault.ownIdentities()
            val checkedAt = checkTime(now())
            var served = fetchServed(groupId, row?.rosterVersion ?: 0uL)
            val owedBefore = vault.oweFamilyGuard(groupId)
            val answer = try {
                var first = ledger.acceptServed(me, groupId, row?.envelope, served, vault.heldFamilyGuard(groupId), checkedAt)
                if (first is ServedAcceptance.FetchFromVersionOne) {
                    served = fetchServed(groupId, 0uL)
                    first = ledger.acceptServed(me, groupId, row?.envelope, served, vault.heldFamilyGuard(groupId), checkedAt)
                }
                first
            } catch (error: Exception) {
                if (!owedBefore) vault.familyGuardKept(groupId)
                throw error
            }
            if (answer !is ServedAcceptance.Accepted && !owedBefore) vault.familyGuardKept(groupId)
            when (answer) {
                is ServedAcceptance.Accepted -> {
                    // Its folders are held as family folders whatever follows: a guard that can't be stored refuses the family
                    // (the core then opens none of them) and the barrier holds writes into them, never taken as personal. Only
                    // for the barrier: a roster's word never makes a folder this family's to clear (ownedBy).
                    vault.holdAsFamilyWorkspaces(answer.chain.areaKeys().keys, groupId)
                    // A guard that can't be stored stops everything of this acceptance, and the barrier stays up until a later one stores it.
                    answer.guard?.let { vault.keepFamilyGuard(groupId, it) }
                    vault.familyGuardKept(groupId)
                    records.put(userId, groupId, FamilyRecords.Row(answer.record, answer.chain.roster().rosterVersion, keptAreas(groupId, answer.chain.areaKeys().keys)))
                    noteAccepted(groupId, answer.chain)
                    return Acceptance.Accepted(answer.chain, answer.pin)
                }
                is ServedAcceptance.Fork -> return Acceptance.Forked(fork(answer.of, answer.version, answer.sides))
                is ServedAcceptance.RecordUnreadable -> {
                    // Its folders' rows and keys go with it (the sweep takes their copies): nothing it tied stays open.
                    vault.forgetWorkspaces(knownAreas(groupId))
                    records.delete(userId, groupId)
                    sweepCopies()
                    return Acceptance.RecordReset
                }
                is ServedAcceptance.Overtaken -> if (++overtaken >= 3) throw FamilyFailure(servedRaceMessage(answer.split))
                is ServedAcceptance.FetchFromVersionOne -> throw FamilyFailure("The server sent this family’s member list inconsistently.")
            }
        }
    }

    /* Route 5 from `after` to the head, a page at a time; pages that disagree on the first keys are refused. */
    internal fun fetchServed(groupId: String, after: ULong): ServedChain {
        val rosters = ArrayList<SignedGroupStatement>()
        val signerKeys = HashMap<String, String>()
        var last: RosterPage? = null
        var cursor = after.toInt()
        for (step in 0 until 64) {
            val page = api.rosters(groupId, cursor)
            if (last != null && last.firstKeys != page.firstKeys) throw FamilyFailure("The server sent this family’s member list inconsistently.")
            rosters.addAll(page.rosters)
            signerKeys.putAll(page.signerKeys)
            last = page
            val next = page.next ?: break
            if (next <= cursor) throw FamilyFailure("The server sent a member list page twice.")
            cursor = next
        }
        if (last == null || last.next != null) throw FamilyFailure("This family’s member list is too long to load.")
        return ServedChain(after, last.firstKeys, rosters, last.successions, signerKeys)
    }

    // Family folders

    /*
     * Every family folder route 25 lists for the family, opened in the ledger as the web's worker opens it
     * (`open_family_area`): this account's self-grant when it is at the folder's current version, else the area grant
     * through its granter's keys from route 6. A self-grant the ledger wraps from a current grant is stored (route 23).
     * The key never leaves the ledger. Then the top folder is listed through the ledger. A folder that doesn't open says
     * "Couldn't check this folder's keys", as the web's row.
     */
    internal fun openAreas(groupId: String, chain: AcceptedRosters): List<Pair<FamilyArea, OpenedArea?>> {
        val listed = api.spaces()[groupId.lowercase()].orEmpty()
        // Only folders whose ids are derived under this family count as its own: never the personal drive, never another family's.
        val family = listed.filter { area -> area.idSeed != null && runCatching { checkId(IdKind.WORKSPACE, groupId, area.idSeed, area.workspaceId) }.isSuccess }
        val proven = family.map { it.workspaceId }.sorted()
        // A folder the family no longer lists (deleted elsewhere): its rows, keys and copies go before anything lets go of
        // the tie between it and the family, so no plaintext of it outlives the last place a cleanup would find it.
        val row = records.read(userId, groupId)
        val dropped = (areasOf[groupId].orEmpty() + row?.areas.orEmpty()).distinct()
            .filter { old -> proven.none { it.equals(old, ignoreCase = true) } && ownedBy(old, groupId) }
        // Let go of only once they are forgotten (never by a closed vault, which forgets nothing).
        val reconciled = if (dropped.isNotEmpty() && !vault.closed) { vault.forgetWorkspaces(dropped); dropped } else emptyList()
        areasOf[groupId] = proven
        note(proven, groupId)
        // The record keeps what it held, the folders proven this family's now, less those just forgotten: merged, never
        // replaced, so a folder deleted while the app was closed is still found after a relaunch.
        if (row != null) {
            val kept = (row.areas + proven).distinctBy { it.lowercase() }.filter { area -> reconciled.none { it.equals(area, ignoreCase = true) } }.sorted()
            // Passed on: folders whose ids couldn't be kept are not opened (the guard and the barrier follow the record).
            if (kept != row.areas.sorted() && !records.put(userId, groupId, row.copy(areas = kept))) throw FamilyRecords.Unsaved()
        }
        sweepCopies()
        val served = fetchIdentities(groupId)
        identities[groupId] = served
        val keyVersion = vault.accountKeyVersion()
        return family.map { area ->
            // The top folder is set only once it proved to be this area's own (below): a refused one is never handed out.
            var folder = FamilyArea(area.workspaceId, rotation = area.rotation)
            var pinArea: OpenedArea? = null
            try {
                val row = area.grant
                val envelope = row?.let { runCatching { base64urlDecode(it.envelope) }.getOrNull() }
                val grant = if (row != null && envelope != null) {
                    // Without this account's identity at the grant's key version it cannot open; the self-grant still may.
                    val holder = try { vault.identityEnvelope(row.granteeKeyVersion) } catch (error: Exception) { if (unanswered(error) || error is NotAuthenticated) throw error; null }
                    holder?.let {
                        // The granter's keys only when route 6 serves their identity: an account gone serves none.
                        val granter = served[row.granterUserId.lowercase()]?.takeIf { m -> m.identity != null }
                        ServedAreaGrant(envelope, row.workspaceKeyVersion, row.granteeKeyVersion, row.granterUserId, row.rosterVersion, row.rosterDigest,
                            granter?.identity?.mlDsaPublicKey?.let { k -> runCatching { base64urlDecode(k) }.getOrNull() },
                            granter?.let { m -> SignerHistory(m.identity!!, m.links) }, it)
                    }
                } else null
                val opened = ledger.openFamilyArea(groupId, ServedArea(area.workspaceId, area.idSeed!!, area.workspaceKeyVersion, grant, area.selfGrant), keyVersion)
                opened.selfGrantToStore?.let { own ->
                    try {
                        api.putSelfGrant(groupId, area.workspaceId, own)
                    } catch (error: GroupsApiError) {
                        if (error.isNotMember) throw error
                        // `area-moved` or no answer: the folder is open now; the next sync wraps the current key again.
                    }
                }
                pinArea = opened.opened.pinArea
                folder = folder.copy(opened = true)
                area.root?.let { root ->
                    // The area's own top folder or nothing: a server naming a folder of another workspace (this account's own
                    // drive, another family's) or one inside the area is the family's Couldn't check, never opened by its own
                    // workspace's key path.
                    if (!isAreaRoot(root, area.workspaceId)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
                    val item = vault.openListed(root)
                    folder = folder.copy(root = root, name = item.name, rootListed = root.parentKeyEpoch == areaWriteVersion(chain, area.workspaceId))
                }
                folder = folder.copy(write = write(opened.opened.reason, folder.rootListed, folder.root != null))
            } catch (error: Exception) {
                if ((error as? GroupsApiError)?.isNotMember == true || unanswered(error) || error is NotAuthenticated) throw error
                folder = folder.copy(root = null, name = null, write = AreaWrite.READ_ONLY)
            }
            folder to pinArea
        }
    }

    /* Route 6, every page: each member's identity and links, by lowercase user id. */
    internal fun fetchIdentities(groupId: String): Map<String, MemberIdentity> {
        val out = HashMap<String, MemberIdentity>()
        var after: String? = null
        repeat(64) {
            val (page, next) = api.identities(groupId, after)
            page.forEach { out[it.userId.lowercase()] = it }
            after = next ?: return out
        }
        throw FamilyFailure("This family has too many members to load.")
    }

    // The settings pin

    private sealed interface Settled {
        class Done(val latest: AcceptedRosters?) : Settled
        class Forked(val fork: FamilyFork) : Settled
    }

    /*
     * The settings pin brought up to the acceptance (the web's settlePin): never lower, compare and set, and areas only
     * from grants opened here. When the stored pin is ahead or names another history, or another device saved
     * meanwhile, the family is accepted again with the settings read anew, and only that acceptance's pin is saved; four tries.
     */
    private fun settle(groupId: String, accepted: GroupPin, checked: FamilyChecked?, opened: List<OpenedArea>): Settled {
        var pin = accepted
        var latest: AcceptedRosters? = null
        repeat(4) {
            val current = vault.familyPin(groupId)
            val merge = mergePin(groupId, current, pin, opened)
            if (merge is PinMerge.Merged) {
                if (!pinAhead(current, merge.pin)) return Settled.Done(latest)
                if (vault.saveGroupPin(groupId, current, merge.pin, checked, checkTime(now()))) return Settled.Done(latest)
            }
            // Behind, a conflict, or a save another device won: accept again against what is stored now.
            when (val again = accept(groupId)) {
                is Acceptance.Forked -> return Settled.Forked(again.fork)
                is Acceptance.Accepted -> { pin = again.pin; latest = again.chain }
                else -> throw FamilyFailure("This device’s saved check of the family could not be opened.")
            }
        }
        throw FamilyFailure("Your settings keep changing on another device. Try again.")
    }

    // Not a member

    /*
     * Only after a 404 `not-member`: the ledger's chain and keys, the device record and the folders opened here go. The
     * settings pin and the family guard stay: if the family comes back, they are still marks, and first use is refused.
     * Nothing goes until the core let go of the family, which waits for the guard it hands back to be stored.
     */
    internal fun wipe(groupId: String) {
        val areas = knownAreas(groupId)
        if (!forgetInCore(groupId)) return
        // Its folders' rows, keys and copies first, then the record that ties them to the family: a stop in between
        // leaves the record, and the next cleanup finds them again.
        vault.forgetWorkspaces(areas, FamilyWords.NOT_IN_FAMILY)
        records.delete(userId, groupId)
        accepted.remove(groupId.lowercase())
        sweepCopies()
        identities.remove(groupId)
        details.remove(groupId)
        areasOf.remove(groupId)
        chains.remove(groupId)
    }

    /*
     * The core lets go of a family (2.8), store before delete: while the guard this phone holds does not cover the
     * highest chain the session accepted, it drops nothing and hands that guard back; it is stored here and the core
     * asked again. A guard that can't be stored or read throws, and nothing is deleted. False when an acceptance landed
     * in between every time: the wipe waits for the next answer.
     */
    internal fun forgetInCore(groupId: String): Boolean {
        val at = checkTime(now())
        repeat(4) {
            val answer = ledger.forgetGroup(groupId, vault.heldFamilyGuard(groupId), at)
            val pin = answer.guard ?: run {
                // Let go of in the core: nothing is written under its chains any more, so no guard is owed.
                vault.familyGuardKept(groupId)
                return true
            }
            if (answer.unreadable) throw GuardUnreadable()
            vault.keepFamilyGuard(groupId, pin)
        }
        return false
    }

    // Verdicts

    /*
     * Who may have written what the family's folders hold, as the core's group verdicts take them (the web's
     * groupWriters): every member route 6 serves, each with this person's pin of them, verified or first-seen; a
     * first-seen pin goes as the family's word (`trustedVia` the family), so keys the member list puts in its place are a
     * key conflict. Built from the current trust set at every judgement. This account's own records go by its own keys.
     */
    private fun groupWriters(served: Map<String, MemberIdentity>, trust: Trust, pins: Map<String, ContactPin>, groupId: String): List<GroupWriter> {
        val me = userId.lowercase()
        fun pinned(id: String): WriterPin? {
            val pin = pins[id.lowercase()] ?: return null
            val digest = pin.mlDsaPublicKeyHash ?: return null
            if (pin.trust != com.hushos.core.PinTrust.VERIFIED && pin.trust != com.hushos.core.PinTrust.SEEN) return null
            return WriterPin(pin.keyVersion, pin.encryptionPublicKey, pin.signingPublicKey, digest, if (pin.trust == com.hushos.core.PinTrust.SEEN) groupId else pin.trustedVia)
        }
        fun personal(id: String): TrustedKeys? = if (id.lowercase() == me) null else trust.keysFor(id)
        val out = HashMap<String, GroupWriter>()
        for ((id, member) in served) out[id] = GroupWriter(member.userId, pinned(id), member.identity, member.identity?.let { member.links }, personal(id))
        for (id in pins.keys) if (out[id] == null && id != me) out[id] = GroupWriter(id, pinned(id), null, null, personal(id))
        return out.values.toList()
    }

    private fun familyNames(groupId: String, pins: Map<String, ContactPin>): FamilyNames {
        val checked = HashMap<String, String>()
        val vouchedBy = HashMap<String, FamilyNames.Vouched>()
        for ((id, pin) in pins) if (pin.verified) {
            checked[id] = pin.name.ifEmpty { pin.email }
            pin.trustedVia?.let { via -> vouchedBy[id] = FamilyNames.Vouched(pin.name, pin.email, names[via] ?: "a family") }
        }
        val members = details[groupId]?.members.orEmpty().associate { it.userId.lowercase() to FamilyNames.Member(it.name, it.email) }
        return FamilyNames(userId, checked, vouchedBy, names[groupId] ?: "the family", members)
    }

    /*
     * Each item's mark and Info lines: its name and current version judged by the family's member list and this
     * account's own keys, then said as the web says them. Without the writers or the reader every record is
     * "Couldn't check", never clean.
     */
    fun verdicts(nodes: List<NodeView>, groupId: String): List<FamilyVerdict> {
        val served = identities[groupId] ?: return nodes.map { FamilyVerdict.unchecked }
        val (trust, pinList) = runCatching { vault.trustAndPins() }.getOrElse { return nodes.map { FamilyVerdict.unchecked } }
        val reader = runCatching { reader() }.getOrElse { return nodes.map { FamilyVerdict.unchecked } }
        val pins = pinList.associateBy { it.userId.lowercase() }
        val writers = groupWriters(served, trust, pins, groupId)
        val lineNames = familyNames(groupId, pins)
        val checked = familyChecked(groupId)
        return nodes.map { node ->
            var judged = listOf(judge(metadataRecord(node), FamilyRecordKind.METADATA, groupId, reader, writers))
            node.currentVersion?.takeIf { !node.isFolder }?.let { judged = judged + judge(versionRecord(node), FamilyRecordKind.VERSION, groupId, reader, writers) }
            if (!checked) judged = judged.map { FamilyLines.asFirstUse(it, groupId) }
            FamilyLines.verdict(judged, lineNames, groupId)
        }
    }

    /*
     * The form a family folder record is signed again with when a write carries it over (a rename's name, a replacement's
     * name): the core's `copy_form` over the committed chain, with this account's records by its own keys and everyone
     * else's by the member list and the pins as this phone's guard allows them (trustAndPins: a pin another device saved
     * over other keys never stands in for the guard). Verified stays ordinary, saved from a link stays saved, anything
     * else is re-sealed; unchecked refuses.
     */
    fun prior(record: ServedRecord, workspaceId: String): Integrity {
        val groupId = groupsOf[workspaceId.lowercase()] ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        val served = identities[groupId] ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        val (trust, pinList) = vault.trustAndPins()
        val pins = pinList.associateBy { it.userId.lowercase() }
        return ledger.copyForm(groupId, reader(), groupWriters(served, trust, pins, groupId), record, null)
    }

    private fun reader(): RecordReader {
        val all = vault.identities(strict = true)
        return RecordReader(userId, TrustedKeys(base64urlDecode(all[0].signingPublicKey), all.drop(1).map { base64urlDecode(it.signingPublicKey) }))
    }

    private fun judge(record: ServedRecord, kind: FamilyRecordKind, groupId: String, reader: RecordReader, writers: List<GroupWriter>): FamilyJudged {
        val verdict = runCatching { ledger.recordVerdict(groupId, reader, writers, record, null) }.getOrNull()
            ?: return FamilyJudged(kind, GroupVerdict.UNCHECKED, null, record.signer, null)
        return when (verdict) {
            is RecordVerdict.Signed -> FamilyJudged(kind, verdict.verdict.verdict, verdict.verdict.via, record.signer, null)
            // A re-keyed record's verdict is its origin's; its own signer is the re-keyer.
            is RecordVerdict.Rekeyed -> FamilyJudged(kind, verdict.verdict.origin.verdict, verdict.verdict.origin.via, record.signer,
                RekeyNote(record.rekey?.origin?.signerId, record.signer, verdict.verdict.rekeyer.verdict, verdict.verdict.bound, verdict.verdict.rekeyer.via))
        }
    }

    // Shapes

    private fun view(groupId: String, chain: AcceptedRosters, areas: List<FamilyArea>, reset: Boolean): FamilyView {
        val roster = chain.roster()
        val owners = ledger.foreignListings().filter { it.groupId.equals(groupId, ignoreCase = true) }.groupingBy { it.openedBy }.eachCount()
        return FamilyView(
            groupId, roster.rosterVersion, chain.rosterDigest(), chain.groupKeyVersion(),
            roster.members.filter { it.status == MemberStatus.ACTIVE }.map { FamilyMember(it.userId, it.roles.map(::role), commitment(it)) },
            areas, reset, chain.ownEntryWrongAt().isNotEmpty(), chain.ownEntryBehindAt().isNotEmpty(),
            owners.map { ForeignNotice(it.key, it.value) }.sortedBy { it.owner.orEmpty() },
        )
    }

    companion object {
        /* What a member check says instead of its words when the family isn't accepted as shown (null: the words show). */
        fun checkProblem(state: FamilyState): String? = when (state) {
            is FamilyState.Accepted -> null
            is FamilyState.Fork -> "This family looks different on this device. Check it from the family page."
            is FamilyState.Failed -> state.words
            FamilyState.Wiped -> FamilyWords.NOT_IN_FAMILY
            FamilyState.Waiting, FamilyState.Unchecked -> GuardWords.UNREADABLE
        }

        /* The words a refused family's folder says: its state's, or "open again". */
        fun checkWordsOf(state: FamilyState?): String = when (state) {
            is FamilyState.Failed -> state.words
            FamilyState.Wiped -> FamilyWords.NOT_IN_FAMILY
            else -> FamilyWords.OPEN_AGAIN
        }

        /* The network's or the server's for now (no answer, a timeout, throttling, a server error): a retry may pass. */
        fun transient(error: Throwable): Boolean = unanswered(error) ||
            (error is GroupsApiError && (error.status == 408 || error.status == 429 || error.status >= 500)) ||
            (error is ApiError && (error.status == 408 || error.status == 429 || error.status >= 500))

        /* A request that got no answer: nothing was refused, so nothing is taken away. */
        fun unanswered(error: Throwable): Boolean = when (error) {
            is GroupsApiError -> error.status == 0
            is Unreachable, is AuthUnreachable, is java.io.IOException, is kotlinx.coroutines.CancellationException -> true
            else -> false
        }

        /* A family area's top folder: a folder of that very workspace, at its top (no parent, or the workspace itself). */
        fun isAreaRoot(root: NodeView, workspaceId: String): Boolean =
            root.workspaceId.equals(workspaceId, ignoreCase = true) && root.isFolder && (root.parentId == null || root.parentId.equals(workspaceId, ignoreCase = true))

        /* A check time as pins carry it: ISO 8601 UTC to the millisecond, as the web's toISOString. */
        fun checkTime(at: Instant): String = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(java.time.ZoneOffset.UTC).format(at.truncatedTo(ChronoUnit.MILLIS))

        /* The key commitment of an entry's four keys (the web's entryCommitment): null for digests that don't decode. */
        fun commitment(entry: RosterMember): String? {
            val mlDsa = runCatching { digestHex(entry.mlDsaPublicKeyDigest) }.getOrNull() ?: return null
            val kem = runCatching { digestHex(entry.kemPublicKeyDigest) }.getOrNull() ?: return null
            return keyCommitment(PinKeys(entry.keyVersion, entry.encryptionPublicKey, entry.signingPublicKey, mlDsa, kem, ""))
        }

        /* Why this person can't leave or step back yet: someone else must hold the role first (the web's copy.ts). */
        const val ORGANIZER_FIRST = "Make someone else the organizer first."
        const val MANAGER_FIRST = "Let someone else manage the family first."

        /*
         * Why this person can't leave now, by the rule the server applies (the web's leaveBlocker), from route 3's members, or
         * null when Leave family can be offered. The last one in a family may always leave: that ends it.
         */
        fun leaveBlocker(userId: String, members: List<GroupDetail.Member>): String? {
            val active = members.filter { it.state == "active" }
            val me = active.firstOrNull { it.userId.equals(userId, ignoreCase = true) } ?: return null
            val others = active.filter { it !== me }
            if (others.isEmpty()) return null
            fun held(role: String) = others.any { role in it.roles }
            if ("billing" in me.roles && !held("billing")) return ORGANIZER_FIRST
            if ("members" in me.roles && !held("members")) return MANAGER_FIRST
            return null
        }

        /* A leave the server refused, in the web's words (copy.ts errorCopy); the payer's in the server's own, as it names where. */
        fun leaveWords(error: GroupsApiError): String = when (error.code) {
            "organizer" -> ORGANIZER_FIRST
            "last-holder" -> MANAGER_FIRST
            "payer" -> error.message ?: error.words
            else -> error.words
        }

        /* The web's names for roles (rolesLine reads `billing` and `members`). */
        fun role(role: GroupRole) = when (role) {
            GroupRole.BILLING -> "billing"
            GroupRole.DATA_ADMIN -> "data-admin"
            GroupRole.GUARDIAN -> "guardian"
            GroupRole.MEMBERS -> "members"
            GroupRole.RECOVERY -> "recovery"
        }

        /* How a member reads in a list: the roles in words, never colour alone (the web's rolesLine). */
        fun rolesLine(roles: List<String>): String {
            val organizer = "billing" in roles
            val manages = "members" in roles
            return when {
                organizer && manages -> "Organizer · Manages the family"
                organizer -> "Organizer"
                manages -> "Manages the family"
                else -> "Member"
            }
        }

        fun fork(of: ForkOf, version: ULong, sides: List<MarkSide>) = FamilyFork(of == ForkOf.ROSTER, version, sides.map { side ->
            FamilyFork.Side(side.digest, side.from.map {
                when (it) {
                    MarkSource.PIN -> "your account’s earlier check"
                    MarkSource.PAIR -> "the family check you made"
                    MarkSource.CACHE -> "this device’s earlier check"
                    MarkSource.JOIN -> "the join code you compared"
                    MarkSource.SERVED -> "what the server shows now"
                }
            })
        })

        /* As the web's areaWrite: what the ledger found, and whether the top folder opened at the latest version. */
        fun write(reason: AreaBlock?, rootListed: Boolean, root: Boolean): AreaWrite = when {
            reason == AreaBlock.NO_GRANT_AT_LATEST -> AreaWrite.READ_ONLY
            reason == AreaBlock.SERVER_BEHIND || reason == AreaBlock.SERVER_AHEAD -> AreaWrite.KEYS_CHANGED
            rootListed -> AreaWrite.WRITABLE
            root -> AreaWrite.KEYS_CHANGED
            else -> AreaWrite.READ_ONLY
        }

        /* Present but unreadable is a signature that cannot hold, as the web reads it. */
        internal fun signature(value: Any?): ByteArray? = (value as? String)?.let { runCatching { base64urlDecode(it) }.getOrDefault(ByteArray(0)) }

        internal fun rekey(raw: JSONObject?): ServedRekey? {
            raw ?: return null
            val origin = raw.optJSONObject("origin") ?: JSONObject()
            fun bytes(name: String) = runCatching { base64urlDecode(origin.getString(name)) }.getOrDefault(ByteArray(0))
            return ServedRekey(ServedOrigin(bytes("envelope"), origin.optJSONObject("signer")?.optString("id")?.ifEmpty { null },
                signature(origin.opt("signature")), bytes("keyEnvelope")), signature(raw.opt("signature")) ?: ByteArray(0))
        }

        internal fun metadataRecord(node: NodeView): ServedRecord {
            val raw = runCatching { JSONObject(node.rawJson) }.getOrNull()
            return ServedRecord(
                RecordStatement.Metadata(MetadataStatement(node.workspaceId, node.id, if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion)),
                node.keyEpoch, runCatching { base64urlDecode(node.metadataEnvelope) }.getOrDefault(ByteArray(0)), node.metadataSigner?.id,
                signature(node.metadataSignature), rekey(raw?.optJSONObject("metadataRekey")),
            )
        }

        internal fun versionRecord(node: NodeView): ServedRecord {
            val version = node.currentVersion!!
            val raw = runCatching { JSONObject(node.rawJson).optJSONObject("currentVersion") }.getOrNull()
            return ServedRecord(
                RecordStatement.Version(VersionStatement(node.workspaceId, node.id, version.id, version.objectId, version.contentSuite)),
                node.keyEpoch, runCatching { base64urlDecode(version.contentKeyEnvelope) }.getOrDefault(ByteArray(0)), version.signer?.id,
                signature(version.signature), rekey(raw?.optJSONObject("rekey")),
            )
        }
    }
}
