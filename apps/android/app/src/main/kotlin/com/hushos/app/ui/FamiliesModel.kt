package com.hushos.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilySync
import com.hushos.app.data.FamilyVerdict
import com.hushos.app.data.FamilyView
import com.hushos.app.data.FamilyWords
import com.hushos.app.data.GroupDetail
import com.hushos.app.data.GroupSummary
import com.hushos.app.data.GroupsApiError
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.NodeView
import com.hushos.app.data.olderThan
import com.hushos.app.data.Opened
import com.hushos.app.data.Vault
import com.hushos.app.data.drainFamilyPurged
import com.hushos.app.data.familyEpoch
import com.hushos.app.data.forgetFamilyCopies
import com.hushos.app.data.rethrowIfCancelled
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File

/* What stands in a family folder's place when it can't be listed: its family's words, or a removal. */
sealed interface FamilyProblem {
    data class Words(val words: String) : FamilyProblem
    data object Removed : FamilyProblem
}

/*
 * Which family each folder on screen is in, for the session (iOS's familyRoots, familyFolders and familyAreaGroups): a
 * top folder by route 25, a folder listed inside a family folder by its workspace, kept when its listing is dropped, so a
 * removal stays said in nested folders, in folders an earlier clear (a refusal, a fork) already dropped, and for a
 * listing that lands after it. Only grows; folders only (a file here would be asked for as a folder by every recovery).
 */
class FamilyFolders {
    /* Each family folder's workspace, lowercase, to its family. */
    val areas = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val roots = java.util.concurrent.ConcurrentHashMap<String, String>()
    /* Each family folder's workspace, by its id (a top folder's from route 25, others from the listing they were in). */
    private val spaces = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val folders = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun noteAreas(found: Map<String, String>) { areas.putAll(found.mapKeys { it.key.lowercase() }) }
    fun noteRoot(rootId: String, groupId: String, workspaceId: String? = null) {
        roots[rootId.lowercase()] = groupId
        workspaceId?.let { spaces[rootId.lowercase()] = it }
    }

    /* The workspace a family folder is in, as this family listed it; never guessed from another workspace's row by the same id. */
    fun workspaceOfFolder(folderId: String): String? = spaces[folderId.lowercase()]

    fun groupOfWorkspace(workspaceId: String): String? = areas[workspaceId.lowercase()]

    /* The family folders' workspaces kept against a family. */
    fun workspacesOf(groupId: String): Set<String> = areas.filterValues { it == groupId }.keys

    /* The family a folder is in: a top folder by route 25, a folder seen in one, else by the workspace of its row. */
    fun groupOf(folderId: String, workspaceOf: (String) -> String?): String? =
        roots[folderId.lowercase()] ?: folders[folderId.lowercase()] ?: workspaceOf(folderId)?.let(::groupOfWorkspace)

    /* A folder listed, and the folders in it, kept against their family. */
    fun listed(folderId: String, children: List<Opened>, workspaceOf: (String) -> String?) {
        groupOf(folderId, workspaceOf)?.let { folders[folderId.lowercase()] = it }
        for (child in children) if (child.isFolder && groupOfWorkspace(child.node.workspaceId) != null) spaces[child.id.lowercase()] = child.node.workspaceId
        for (child in children) if (child.isFolder) groupOfWorkspace(child.node.workspaceId)?.let { folders[child.id.lowercase()] = it }
    }

    /*
     * The folders a family's clear says its words in: every folder on screen that holds its items, the folders among
     * those items, its top folders, and every folder kept against it before (an earlier clear's included).
     */
    fun cleared(groupId: String, shown: Map<String, List<Opened>>, tops: Collection<String>): Set<String> {
        val ids = HashSet<String>(tops.map { it.lowercase() })
        for ((folderId, items) in shown) {
            val family = items.filter { groupOfWorkspace(it.node.workspaceId) == groupId }
            if (family.isNotEmpty()) ids.add(folderId.lowercase())
            family.filter { it.isFolder }.forEach { ids.add(it.id.lowercase()) }
        }
        ids.addAll(folders.filterValues { it == groupId }.keys)
        ids.addAll(roots.filterValues { it == groupId }.keys)
        for (id in ids) folders[id] = groupId
        return ids
    }

    fun isFamilyFolder(folderId: String, workspaceOf: (String) -> String?) = groupOf(folderId, workspaceOf) != null

    /*
     * Every row of a family whose copies a wipe removes: what is listed now and every node the session opened of the
     * family's folders (`opened`, the vault's family nodes to their workspace), so a file opened, then deleted by another
     * member and dropped from a later listing, still loses its plaintext copy and thumbnail.
     */
    fun wipeIds(groupId: String, shown: Map<String, List<Opened>>, opened: Map<String, String>): Set<String> =
        shown.values.flatten().filter { groupOfWorkspace(it.node.workspaceId) == groupId }.map { it.id }.toSet() +
            opened.filterValues { groupOfWorkspace(it) == groupId }.keys
}

/*
 * What the families need of the drive beside them (DriveViewModel): the session's vault, its state, and where a family
 * operation's work runs. A test stands in for it with vaults of its own.
 */
interface FamilyHost {
    val currentVault: Vault?
    val cacheDir: File
    val state: StateFlow<DriveState>
    val familyScope: CoroutineScope
    fun item(id: String): Opened?
    fun updateState(change: (DriveState) -> DriveState)
    fun lostSession()
}

/* The session a families operation began in: every nested call and every step after a suspension checks this one. */
typealias FamilySession = SessionToken<Vault>

/*
 * Families on this phone, beside the drive (iOS's DriveStore+Families): route 2's list, each family's last sync and the
 * page it draws, which folders are whose, the marks of what they hold, and the sheets that must outlive the screen that
 * started them (the invitation, a member's check). Every rule is FamilySync's; this keeps the screens' state.
 *
 * Every operation captures its session once, at its outermost entry, and passes it down: a request runs only for that
 * session, and what it answers (rows, a refusal, a 401) is published only while that session is still the current one.
 */
class FamiliesModel(private val model: FamilyHost, private val now: () -> Long = System::currentTimeMillis) {
    private val gate = SessionGate { model.currentVault }
    var list by mutableStateOf<List<GroupSummary>?>(null)
        private set
    /* Whether this server serves families: null until route 2 answers, false once it said it has none (404/501). */
    var served by mutableStateOf<Boolean?>(null)
        private set
    val states = mutableStateMapOf<String, FamilyState>()
    /* Each family's name as route 2 last listed it, kept after it stops listing one (a removal's page names it). */
    val names = mutableStateMapOf<String, String>()
    /* The last accepted view of each family, kept while no answer leaves what was opened open. */
    val shown = mutableStateMapOf<String, FamilyView>()
    val details = mutableStateMapOf<String, GroupDetail>()
    val syncing = mutableStateMapOf<String, Boolean>()
    /* Moved after every finished check of a family: the member labels are read again. */
    val refreshed = mutableStateMapOf<String, Int>()
    val problems = mutableStateMapOf<String, FamilyProblem>()
    var folders = FamilyFolders()
        private set
    private val verdicts = FamilyVerdicts { folders.groupOfWorkspace(it) }
    private val checkedAt = HashMap<String, Long>()
    private var syncedAt = 0L
    private var ticks = 0
    /* Join screens open per family (a count): while any is open the screen owns the family; background checks wait. */
    private val joining = HashMap<String, Int>()

    /* The mailed invitation, as the sheet's own state ("" for a link whose token was cut off), drawn by Main. */
    var invitation by mutableStateOf<String?>(null)
    /* A member's check, drawn by Main so it outlives the row and the page it started from. */
    var checking by mutableStateOf<MemberCheck?>(null)

    fun invite(token: String?) { invitation = token ?: "" }

    /* The session a screen's families work begins in; null when signed out. */
    fun begin(): FamilySession? = gate.begin()
    fun current(session: FamilySession): Boolean = gate.current(session)
    /* The block against the session's own families, or null when that session ended or changed meanwhile. */
    suspend fun <T> run(session: FamilySession, block: (FamilySync) -> T): Result<T>? = gate.run(session) { block(session.owner.families) }

    /* A family folder's workspace: as this family listed it, or as the vault opened it through a family; never by id alone. */
    private fun workspaceOf(id: String): String? = folders.workspaceOfFolder(id) ?: model.currentVault?.familyNodes?.get(id)

    fun groupOfFolder(folderId: String): String? = folders.groupOf(folderId, ::workspaceOf)
    fun isFamilyFolder(folderId: String): Boolean = folders.isFamilyFolder(folderId, ::workspaceOf)
    fun isFamilyItem(item: Opened): Boolean = folders.groupOfWorkspace(item.node.workspaceId) != null || model.currentVault?.familyAreas?.containsKey(item.node.workspaceId.lowercase()) == true
    fun familyOf(item: Opened): String? = folders.groupOfWorkspace(item.node.workspaceId)
    fun name(groupId: String): String = list?.firstOrNull { it.id == groupId }?.name ?: names[groupId] ?: "Family"

    /*
     * Check it's <name> for someone in a family, as the family page opens it (Info's "Added by" on a first-seen writer):
     * null when they aren't in the family's accepted member list now, or the family isn't listed.
     */
    fun memberCheck(groupId: String, userId: String, me: String): MemberCheck? {
        val summary = list?.firstOrNull { it.id == groupId } ?: return null
        val view = (states[groupId] as? FamilyState.Accepted)?.view ?: shown[groupId] ?: return null
        if (view.members.none { it.userId.equals(userId, ignoreCase = true) }) return null
        val named = details[groupId]?.members.orEmpty().filter { it.state == "active" }
        fun served(id: String) = named.firstOrNull { it.userId.equals(id, ignoreCase = true) }
        val who = served(userId)
        val organizer = view.members.firstOrNull { "billing" in it.roles && !it.userId.equals(me, ignoreCase = true) }?.let { served(it.userId) }
            ?.let { com.hushos.app.data.firstNameOf(it.name) }
        return MemberCheck(summary, com.hushos.app.data.FamilyMemberRef(userId, who?.email.orEmpty(), who?.name ?: "Someone"),
            served(me)?.name?.let { com.hushos.app.data.firstNameOf(it) } ?: "you", organizer)
    }

    /* The family's verdict for an item as it is now; null while it is being judged. */
    fun verdict(item: Opened): FamilyVerdict? = verdicts.of(item)

    /*
     * Each family folder item's mark and Info lines, judged once per version of its row, a family at a time. A judgement
     * publishes only for the session and the family's trust generation it began under: one that finishes after the
     * family's pins, guard or sync moved is dropped, and the newer judgement stands.
     */
    fun judge(items: List<Opened>, session: FamilySession? = null) = model.familyScope.launch {
        val s = session ?: begin() ?: return@launch
        val due = items.filter { isFamilyItem(it) && verdict(it) == null }.groupBy { familyOf(it) }
        for ((groupId, group) in due) {
            groupId ?: continue
            val trust = verdicts.capture(groupId)
            val result = gate.run(s) { s.owner.families.verdicts(group.map { it.node }, groupId) } ?: return@launch
            if (!gate.current(s)) return@launch
            // A judgement that failed outright says "Couldn't check", never no mark.
            val judged = result.getOrElse { error -> error.rethrowIfCancelled(); group.map { FamilyVerdict.unchecked } }
            verdicts.publish(groupId, trust, group.zip(judged))
        }
    }

    /* Every family mark judged again (a sync accepted, pins changed): what is on screen now, under a new trust generation. */
    fun rejudge(groupId: String? = null, session: FamilySession? = null) {
        verdicts.moved(groupId)
        judge(model.state.value.folders.values.flatten().filter { isFamilyItem(it) }, session)
    }

    /*
     * Route 2, then every family checked. A pass within a minute is reused unless `force` (a pull, a removed folder asked
     * again). A family this phone holds that the list no longer names is asked about (route 5), and dropped only on the
     * server's not-member. A server without families shows none; no answer leaves what was shown.
     */
    suspend fun refreshFamilies(force: Boolean = false, maxAgeMs: Long = 60_000, session: FamilySession? = null) {
        val s = session ?: begin() ?: return
        if (!gate.current(s) || !familiesDue(now(), syncedAt, list != null, force, maxAgeMs)) return
        val result = gate.run(s) { s.owner.families.listReconciling() } ?: return
        result.onSuccess { (listed, gone) ->
            listed.forEach { names[it.id] = it.name }
            list = listed
            served = true
            syncedAt = now()
            gone.forEach { if (it.state == FamilyState.Wiped) removed(it.groupId!!, s, it.revision) else unlistedFailed(it.groupId!!, it.state, s, it.revision) }
            for (summary in listed) {
                if (!gate.current(s)) return
                refreshFamily(summary, session = s)
            }
        }.onFailure { error ->
            error.rethrowIfCancelled()
            when {
                error is NotAuthenticated -> model.lostSession()
                error is GroupsApiError && (error.status == 404 || error.status == 501) -> { list = null; served = false }
                // No answer: what was shown stays; the live sync asks again.
            }
        }
    }

    /* Every minute or so while the app is on screen (the live sync's tick): a removal elsewhere reaches an open app. */
    suspend fun tick() {
        if (ticks++ % 6 == 0 && served != false) refreshFamilies(maxAgeMs = FAMILY_TICK_AGE_MS)
    }

    /* One family checked again. Skipped while a join screen is open for it, unless the join screen asks. */
    suspend fun refreshFamily(summary: GroupSummary, fromJoin: Boolean = false, session: FamilySession? = null) {
        val s = session ?: begin() ?: return
        if (!gate.current(s) || syncing[summary.id] == true || (!fromJoin && (joining[summary.id] ?: 0) > 0)) return
        syncing[summary.id] = true
        try {
            val revised = (gate.run(s) { s.owner.families.syncRevised(summary) } ?: return).getOrElse { error ->
                error.rethrowIfCancelled()
                if (error is NotAuthenticated) { model.lostSession(); return }
                FamilySync.Revised(FamilyState.Failed(FamilyWords.error(error)), 0L)
            }
            show(revised.state, summary, s, revised.revision.takeIf { it > 0L })
        } finally {
            // A reset cleared it already; the next session may be checking the same family by now.
            if (gate.current(s)) syncing.remove(summary.id)
        }
    }

    /* A family folder on screen checks its family again when the last check is older than `maxAge`. */
    suspend fun refreshIfStale(folderId: String, maxAgeMs: Long, session: FamilySession? = null) {
        val s = session ?: begin() ?: return
        val groupId = groupOfFolder(folderId) ?: return
        val summary = list?.firstOrNull { it.id == groupId } ?: return
        if (now() - (checkedAt[groupId] ?: 0L) < maxAgeMs) return
        refreshFamily(summary, session = s)
    }

    fun openJoin(groupId: String) { joining[groupId] = (joining[groupId] ?: 0) + 1 }
    fun closeJoin(groupId: String) { joining[groupId] = ((joining[groupId] ?: 1) - 1).coerceAtLeast(0) }

    /* A join that finished on the join screen: shown as a sync's would be, with route 2 read again (no second acceptance). */
    suspend fun joined(groupId: String, state: FamilyState, session: FamilySession, revision: Long? = null) {
        if (!gate.current(session)) return
        gate.run(session) { session.owner.families.list() }?.getOrNull()?.let { listed ->
            list = listed
            listed.forEach { names[it.id] = it.name }
            syncedAt = now()
        }
        if (!gate.current(session)) return
        val summary = list?.firstOrNull { it.id == groupId } ?: run {
            if (!later(groupId, state, revision)) return
            states[groupId] = state
            rejudge(groupId, session)
            return
        }
        show(state, summary, session, revision)
    }

    /*
     * A sync's outcome a screen ran itself (Check it's Sam's "Getting the latest"), shown as any sync's is when it is a
     * later look at the family than what is on screen (its revision, taken inside the family's turn): a check queued
     * behind a background check shows what it found after it. A fork or a removal always shows. False when nothing was.
     */
    suspend fun adopt(state: FamilyState, summary: GroupSummary, session: FamilySession, revision: Long?): Boolean {
        if (!gate.current(session)) return false
        return show(state, summary, session, revision)
    }

    /* Each family folder listing's start order, and the latest one shown per folder. */
    private val listings = java.util.concurrent.atomic.AtomicLong()
    private val listed = HashMap<String, Long>()

    /* The revision of what each family shows now (FamilySync.syncRevised); an answer at or below it is older. */
    private val shownRevision = HashMap<String, Long>()

    /*
     * Whether an answer at `revision` may replace what `groupId` shows: a later look, or a fork or a removal. An answer
     * with no revision (a sync that failed outside its turn) shows only while nothing ordered has.
     */
    private fun later(groupId: String, state: FamilyState, revision: Long?): Boolean {
        val shown = shownRevision[groupId] ?: Long.MIN_VALUE
        if (revision == null && shown != Long.MIN_VALUE && state !is FamilyState.Fork && state != FamilyState.Wiped) return false
        if (revision != null && revision <= shown && state !is FamilyState.Fork && state != FamilyState.Wiped) return false
        if (revision != null && revision > shown) shownRevision[groupId] = revision
        return true
    }

    /*
     * What a family's proof purged (a share's kept files, kept folders and copies in a folder now proven a family's) leaves
     * the screens: On this phone's rows and the thumbnails drawn from them. The files themselves went with the proof.
     */
    private fun dropPurged(vault: Vault) {
        val purged = vault.drainFamilyPurged().map { it.lowercase() }.toSet()
        if (purged.isEmpty()) return
        model.updateState { st ->
            st.copy(offline = st.offline.filter { it.id.lowercase() !in purged }, keptFolders = st.keptFolders.filter { it.id.lowercase() !in purged },
                thumbnails = st.thumbnails.filterKeys { thumbnailItem(it).lowercase() !in purged })
        }
    }

    /* Whether a family folder may be listed in this family state: accepted, or no answer (what was opened stays). Never refused. */
    private fun admits(state: FamilyState?): Boolean =
        state == null || state is FamilyState.Accepted || (state is FamilyState.Failed && state.words == FamilyWords.NO_ANSWER)

    private suspend fun show(state: FamilyState, summary: GroupSummary, s: FamilySession, revision: Long? = null): Boolean {
        if (!gate.current(s) || !later(summary.id, state, revision)) return false
        val sync = s.owner.families
        val previous = states[summary.id]
        states[summary.id] = state
        checkedAt[summary.id] = now()
        refreshed[summary.id] = (refreshed[summary.id] ?: 0) + 1
        // The trust generation moves only with a sync that changed something: an accepted one (rejudge) or a clear. No
        // answer keeps the rows on screen with the verdicts they had ("Keys don't match" stays said).
        folders.noteAreas(sync.familyAreas())
        dropPurged(s.owner)
        when {
            state is FamilyState.Accepted -> {
                shown[summary.id] = state.view
                state.view.areas.forEach { area -> area.root?.let { folders.noteRoot(it.id, summary.id, it.workspaceId) } }
                sync.detail(summary.id)?.let { details[summary.id] = it }
                // Listed again, not only judged again: a walk since may have re-keyed every row on screen; folders a
                // refusal, a fork or a removal took off screen open again now.
                val again = model.state.value.folders.filter { (id, items) -> groupOfFolder(id) == summary.id || items.any { familyOf(it) == summary.id } }.keys +
                    problems.keys.filter { groupOfFolder(it) == summary.id }
                for (id in again) {
                    if (!gate.current(s)) return true
                    refreshFolder(id, s)
                }
                if (!gate.current(s)) return true
                rejudge(summary.id, s)
            }
            // No answer: what this phone opened before stays on screen, read only.
            state is FamilyState.Failed && state.words == FamilyWords.NO_ANSWER -> {}
            else -> {
                val roots = (previous as? FamilyState.Accepted)?.view?.areas?.mapNotNull { it.root?.id }.orEmpty()
                clear(summary.id, roots, s, details = state == FamilyState.Wiped, problem = if (state == FamilyState.Wiped) FamilyProblem.Removed else FamilyProblem.Words(FamilyWords.OPEN_AGAIN))
            }
        }
        return true
    }

    /* A family the server says this account is no longer in, found while it wasn't listed: shown as a sync's Wiped is. */
    private fun removed(groupId: String, s: FamilySession, revision: Long) {
        // Ordered like every other answer: a member check's Accepted from before this removal never shows after it.
        if (!later(groupId, FamilyState.Wiped, revision)) return
        val roots = ((states[groupId] as? FamilyState.Accepted)?.view ?: shown[groupId])?.areas?.mapNotNull { it.root?.id }.orEmpty()
        states[groupId] = FamilyState.Wiped
        checkedAt[groupId] = now()
        refreshed[groupId] = (refreshed[groupId] ?: 0) + 1
        clear(groupId, roots, s, details = true, problem = FamilyProblem.Removed)
    }

    /*
     * A family the server says this account is no longer in, found while it wasn't listed, whose wipe couldn't finish (its
     * guard not stored): refused, so what was drawn of it goes and its folders say its words until a later list wipes it.
     */
    private fun unlistedFailed(groupId: String, state: FamilyState, s: FamilySession, revision: Long) {
        if (!later(groupId, state, revision)) return
        val roots = ((states[groupId] as? FamilyState.Accepted)?.view ?: shown[groupId])?.areas?.mapNotNull { it.root?.id }.orEmpty()
        states[groupId] = state
        checkedAt[groupId] = now()
        refreshed[groupId] = (refreshed[groupId] ?: 0) + 1
        clear(groupId, roots, s, details = false, problem = FamilyProblem.Words((state as? FamilyState.Failed)?.words ?: FamilyWords.OPEN_AGAIN))
    }

    /*
     * What this phone drew and decrypted of a family that isn't accepted now (the web's deleteMirrors): its folders'
     * lists, thumbnails and marks, and the plaintext copies opened from them. The folders stay family folders.
     */
    private fun clear(groupId: String, roots: List<String>, s: FamilySession, details: Boolean, problem: FamilyProblem) {
        val ids = folders.cleared(groupId, model.state.value.folders, roots)
        val items = folders.wipeIds(groupId, model.state.value.folders, s.owner.familyNodes)
        model.updateState { st ->
            st.copy(folders = st.folders.filterKeys { it.lowercase() !in ids }, thumbnails = st.thumbnails.filterKeys { thumbnailItem(it) !in items && thumbnailItem(it) !in ids }, failedFolders = st.failedFolders - ids)
        }
        for (id in ids) problems[id] = problem
        // The sync's forget deleted the copies of the folders its records know; these are the ones this session saw.
        s.owner.forgetFamilyCopies(folders.workspacesOf(groupId))
        verdicts.moved(groupId)
        shown.remove(groupId)
        if (details) this.details.remove(groupId)
    }

    /*
     * A family folder listed: its family checked first when the last check is a few minutes old. A folder of a family the
     * server says this account was removed from stays said as such (asked again first, on a pull), and a removal that
     * lands while the listing is out wins over its answer. Everything after a suspension checks the session it began in.
     */
    suspend fun refreshFolder(id: String, session: FamilySession? = null) {
        val s = session ?: begin() ?: return
        val vault = s.owner
        fun removed(): Boolean {
            val groupId = groupOfFolder(id) ?: return false
            if (states[groupId] != FamilyState.Wiped) return false
            model.updateState { it.copy(folders = it.folders - id, loading = it.loading - id) }
            problems[id] = FamilyProblem.Removed
            return true
        }
        // A family refused (a rollback, a fork, keys that didn't check) lists nothing: its words stay until a check accepts it.
        fun refused(): Boolean {
            val groupId = groupOfFolder(id) ?: return false
            val state = states[groupId]
            if (admits(state)) return false
            model.updateState { it.copy(folders = it.folders - id, loading = it.loading - id) }
            if (problems[id] == null) problems[id] = FamilyProblem.Words(FamilySync.checkWordsOf(state))
            return true
        }
        if (!gate.current(s)) return
        if (removed()) {
            refreshFamilies(force = true, session = s)
            if (!gate.current(s) || removed()) return
        }
        refreshIfStale(id, 180_000, s)
        if (!gate.current(s) || removed() || refused()) return
        model.updateState { it.copy(loading = it.loading + id, failedFolders = it.failedFolders - id) }
        // The folder's family invalidation before listing: a fork, a refusal or a removal that lands while the listing is
        // out wins over what it opened, so its words stay and its rows don't come back.
        val workspace = workspaceOf(id)
        val epoch = workspace?.let(vault::familyEpoch)
        // Listings of one folder overlap (a tick, a pull, a sync's relist): the one begun last is what shows, so an older
        // listing landing late never puts back older rows (and verdicts keyed to the newer ones).
        val listing = listings.incrementAndGet()
        val result = gate.run(s) { vault.listChildren(id, workspace) } ?: run {
            if (gate.current(s)) model.updateState { it.copy(loading = it.loading - id) }
            return
        }
        if (removed() || refused()) return
        if (listing < (listed[id.lowercase()] ?: 0L)) {
            model.updateState { it.copy(loading = it.loading - id) }
            return
        }
        listed[id.lowercase()] = listing
        if (workspace != null && vault.familyEpoch(workspace) != epoch) {
            model.updateState { it.copy(loading = it.loading - id) }
            return
        }
        result.onSuccess { children ->
            folders.listed(id, children, ::workspaceOf)
            problems.remove(id)
            model.updateState { it.copy(folders = it.folders + (id to children), loading = it.loading - id, unreachable = false) }
            judge(children, s)
        }.onFailure { error ->
            error.rethrowIfCancelled()
            model.updateState { it.copy(loading = it.loading - id) }
            when {
                error is NotAuthenticated -> model.lostSession()
                // No answer: the folder's own Try again, as any folder's.
                FamilySync.unanswered(error) -> model.updateState { it.copy(unreachable = true, failedFolders = if (it.folders.containsKey(id)) it.failedFolders else it.failedFolders + id) }
                // A family folder's refusal is said in the families' words, never as an empty folder.
                else -> { model.updateState { it.copy(folders = it.folders - id) }; problems[id] = FamilyProblem.Words(FamilyWords.error(error)) }
            }
        }
    }

    /* Try again on a family folder that couldn't be opened: the family checked again, then the folder, in one session. */
    fun reopen(folderId: String) = model.familyScope.launch {
        val s = begin() ?: return@launch
        groupOfFolder(folderId)?.let { groupId -> list?.firstOrNull { it.id == groupId }?.let { refreshFamily(it, session = s) } }
        refreshFolder(folderId, s)
    }

    /* Sign-out, a lost session: nothing of the last account's families stays drawn. */
    fun reset() {
        gate.reset()
        list = null; served = null; invitation = null; checking = null
        states.clear(); names.clear(); shown.clear(); details.clear(); syncing.clear(); refreshed.clear(); problems.clear(); verdicts.reset()
        checkedAt.clear(); joining.clear(); syncedAt = 0L; folders = FamilyFolders(); held = null; heldStack = emptyMap(); shownRevision.clear()
    }

    /*
     * The family top folder on screen, as last opened here, kept in memory beside the drive (never saved): a removal or a
     * refusal forgets its row, and a rotation or a fold redraws the folder from this, still saying so, never popping away
     * under the person. One at a time; let go when the folder is left, and at sign-out.
     */
    private var held: Opened? = null
    fun hold(root: Opened) { held = root }
    fun held(workspaceId: String, rootId: String): Opened? =
        held?.takeIf { it.id.equals(rootId, ignoreCase = true) && it.node.workspaceId.equals(workspaceId, ignoreCase = true) }
    fun release(workspaceId: String, rootId: String) { if (held(workspaceId, rootId) != null) { held = null; heldStack = emptyMap() } }

    /*
     * The family folders open below it (BrowseScreen's stack), the same way: a removal or a refusal forgets their rows,
     * and a fold redraws the nested folder from these, with its words (`problems`). In memory only, never saved.
     */
    private var heldStack: Map<String, Opened> = emptyMap()
    fun holdStack(stack: List<Opened>) { heldStack = stack.filter(::isFamilyItem).associateBy { it.node.workspaceId.lowercase() + "|" + it.id.lowercase() } }
    fun heldFolder(workspaceId: String, id: String): Opened? = heldStack[workspaceId.lowercase() + "|" + id.lowercase()]

    /*
     * A redraw's or a write's relist (DriveViewModel): every family folder among `folderIds` goes through refreshFolder
     * (its session, ordering, epoch and refusal guards), never a plain listing merged blindly. The rest, for the drive.
     */
    suspend fun relist(folderIds: Collection<String>): List<String> {
        val (family, plain) = folderIds.partition { isFamilyFolder(it) }
        if (family.isNotEmpty()) {
            val s = begin() ?: return plain
            for (id in family) {
                if (!gate.current(s)) break
                refreshFolder(id, s)
            }
        }
        return plain
    }
}

/*
 * Each family item's verdict, keyed by its row, under its family's trust generation: moved by every family sync, pin or
 * guard change and clear (one family), and by a trust change (all of them). A judgement captured under an older
 * generation never publishes, so an unchanged row can't keep a Verified its family's check took back, or lose a newer
 * warning to an older judgement that finished last.
 */
class FamilyVerdicts(private val groupOfWorkspace: (String) -> String?) {
    data class Trust(val epoch: Long, val generation: Long)

    private val byRow = mutableStateMapOf<String, Pair<NodeView, FamilyVerdict>>()
    private val generations = HashMap<String, Long>()
    private var epoch = 0L

    private fun key(item: Opened) = item.node.workspaceId.lowercase() + "|" + item.id

    fun of(item: Opened): FamilyVerdict? = byRow[key(item)]?.takeIf { it.first == item.node }?.second

    fun capture(groupId: String): Trust = Trust(epoch, generations[groupId] ?: 0L)

    /* A family's trust moved (null: every family's): its verdicts are dropped and judgements begun before it never land. */
    fun moved(groupId: String?) {
        if (groupId == null) epoch++ else generations[groupId] = (generations[groupId] ?: 0L) + 1
        byRow.keys.filter { groupId == null || groupOfWorkspace(it.substringBefore('|')) == groupId }.forEach { byRow.remove(it) }
    }

    /*
     * Publishes a judgement begun under `trust`; false, and nothing changed, when the family's trust moved since. A row's
     * judgement for an older version than the one held (two listings overlapping) is dropped: the newer one stands.
     */
    fun publish(groupId: String, trust: Trust, judged: List<Pair<Opened, FamilyVerdict>>): Boolean {
        if (trust != capture(groupId)) return false
        for ((item, verdict) in judged) {
            val held = byRow[key(item)]?.first
            if (held != null && item.node.olderThan(held)) continue
            byRow[key(item)] = item.node to verdict
        }
        return true
    }


    fun reset() {
        epoch++
        byRow.clear()
    }
}

/*
 * Family work belongs to the session it began in (the vault it read through): an answer, or a failure, that lands after a
 * sign-out, an account switch or a new session is dropped before it touches anything, so the next account never sees
 * the last one's families and a late "signed out" never signs it out. The session is captured once (`begin`) at an
 * operation's outermost entry and checked at every step: a request never starts for a session that has ended, and its
 * answer is returned only while that session is still the current one. Reset cancels what is in flight too.
 */
class SessionToken<S : Any> internal constructor(val generation: Long, val owner: S, internal val job: kotlinx.coroutines.Job)

class SessionGate<S : Any>(private val session: () -> S?) {
    @Volatile private var generation = 0L
    private var work = kotlinx.coroutines.SupervisorJob()

    fun reset() = synchronized(this) {
        generation++
        work.cancel()
        work = kotlinx.coroutines.SupervisorJob()
    }

    /* The session now, as a token every later step checks; null when there is none. */
    fun begin(): SessionToken<S>? = synchronized(this) { session()?.let { SessionToken(generation, it, work) } }

    fun current(token: SessionToken<S>): Boolean = synchronized(this) { token.generation == generation } && session() === token.owner

    /* The block off the main thread for the token's session, or null when that session ended or changed, before or meanwhile. */
    suspend fun <T> run(token: SessionToken<S>, block: () -> T): Result<T>? {
        if (!current(token)) return null
        val result = try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO + token.job) { runCatching(block) }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            // Our own cancellation (a reset) drops the answer; the caller's own is passed on.
            kotlinx.coroutines.currentCoroutineContext().let { if (it[kotlinx.coroutines.Job]?.isActive == false) throw cancelled }
            return null
        }
        return result.takeIf { current(token) }
    }
}

/*
 * Whether Info's item is out of this account's reach: a family folder's item while its family stands (accepted, not yet
 * checked, or no answer) is in reach, and out only once the server said this account was removed; anything else outside
 * this account's own workspace only while the shares just listed hold it.
 */
fun outOfReach(workspaceId: String, own: String?, shares: List<String>?, family: Boolean, familyState: com.hushos.app.data.FamilyState?): Boolean {
    if (own == null) return false
    if (family) return familyState == com.hushos.app.data.FamilyState.Wiped
    val listed = shares ?: return false
    return workspaceId != own && workspaceId !in listed
}

/* What search looks through: this drive's rows and the family rows listed this session, each once (the lists key rows by id). */
fun searchableRows(base: List<Opened>, folders: Map<String, List<Opened>>, family: (Opened) -> Boolean): List<Opened> =
    (base + folders.values.flatten().filter(family)).distinctBy { it.id }

/* How old a families pass may be at the live sync's minute tick: under the minute, so a pass stamped at its end never skips a tick. */
const val FAMILY_TICK_AGE_MS = 45_000L

/* Whether route 2 is asked again: forced, never listed, or the last pass older than `maxAgeMs`. */
fun familiesDue(now: Long, syncedAt: Long, listed: Boolean, force: Boolean, maxAgeMs: Long): Boolean = force || !listed || now - syncedAt >= maxAgeMs
