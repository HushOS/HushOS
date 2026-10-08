package com.hushos.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import android.app.Application
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hushos.app.BuildConfig
import com.hushos.app.data.Auth
import com.hushos.app.data.catalogueAll
import com.hushos.app.data.BillingSummary
import com.hushos.app.data.StorageAllowance
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Unreachable
import com.hushos.app.data.Contact
import com.hushos.app.data.ContactPin
import com.hushos.app.data.LinkView
import com.hushos.app.data.Lookup
import com.hushos.app.data.OwnedShare
import com.hushos.app.data.SharedByMe
import com.hushos.app.data.Offline
import com.hushos.app.data.Opened
import com.hushos.app.data.sync
import com.hushos.app.data.buildCatalogue
import com.hushos.app.data.CatalogueState
import com.hushos.app.data.SessionUser
import com.hushos.app.data.ShareView
import com.hushos.app.data.TagRegistry
import com.hushos.app.data.saveTags
import com.hushos.app.data.tags
import com.hushos.app.data.Shared
import com.hushos.app.data.StorageBreakdown
import com.hushos.app.data.TrashItem
import com.hushos.app.data.Vault
import com.hushos.app.data.VersionListView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

enum class Gate { CHECKING, SIGNED_OUT, SIGNED_IN }

/* A short line after an action, with a way to take it back ("Moved 2 items to Trash · Undo") or to go where it points. */
data class Notice(val id: Long, val text: String, val undo: (() -> Unit)? = null, val action: String = "Undo")

/* A transfer in flight or just finished, with its own bar, as the web's panel shows them. */
data class TransferItem(
    val id: String, val kind: String, val name: String, val fraction: Float, val done: Boolean = false, val failed: Boolean = false,
    /* A kept folder: one job for everything in it, and how many of its files are done of how many. */
    val folder: Boolean = false,
    val files: Pair<Int, Int>? = null,
    /* Queued and waiting for a network (or its next try); shown without a bar. */
    val waiting: Boolean = false,
    /* Stops a queued transfer; null for the ones that run in the app. */
    val cancel: (() -> Unit)? = null,
    /* Why a transfer failed (the server's words for a refusal). */
    val message: String? = null,
    /* Clears a failed row; it stays until then, until the panel is closed, or until another transfer starts. */
    val dismiss: (() -> Unit)? = null,
    /* Sends a failed upload again from the copy it kept; null when there is nothing to send. */
    val retry: (() -> Unit)? = null,
    /* The node a keep is fetching, so its menu can say so. */
    val node: String? = null,
) {
    /* Refused for want of room: the sheet offers Make room, not Retry. */
    val noRoom: Boolean get() = failed && com.hushos.app.data.TransferQueue.isNoRoom(message)
}

data class DriveState(
    val gate: Gate = Gate.CHECKING,
    val user: SessionUser? = null,
    val origin: String = "https://hushos.com",
    val rootId: String? = null,
    val folders: Map<String, List<Opened>> = emptyMap(),
    val recents: List<Opened> = emptyList(),
    val trash: List<TrashItem> = emptyList(),
    val thumbnails: Map<String, ByteArray> = emptyMap(),
    val storage: StorageBreakdown? = null,
    val shares: List<Vault.ShareMount>? = null,
    val offline: List<Offline.Entry> = emptyList(),
    /* Folders kept on this phone; their files are in `offline` with `via` set. */
    val keptFolders: List<Offline.Folder> = emptyList(),
    /* Files of kept folders that couldn't be kept, with why and when they're tried next. */
    val keepFailures: List<com.hushos.app.data.KeepFailure> = emptyList(),
    val allowance: StorageAllowance? = null,
    val tags: TagRegistry = TagRegistry.empty(),
    /* What Copy or Cut picked up, until Paste places it. */
    val clipboard: Pair<List<Opened>, Boolean>? = null,
    val billing: BillingSummary? = null,
    val transfers: List<TransferItem> = emptyList(),
    /* Uploads and keeps in the background queue (see TransferQueue), as the panel shows them. */
    val queued: List<TransferItem> = emptyList(),
    /* The add menu is open: the transfer panel steps aside, since it would cover the menu's items. */
    val addMenuOpen: Boolean = false,
    /* Files being fetched to open, by node id, with progress: a ring on the row, not a banner. */
    val opening: Map<String, Float> = emptyMap(),
    val notice: Notice? = null,
    /* An alert's words: a title, what to do, and the raw detail for Details only. */
    val error: com.hushos.app.data.Problem? = null,
    val busy: Boolean = false,
    /* Trash rows being restored or deleted, and the whole trash being emptied: each shows it is under way. */
    val trashWorking: Set<String> = emptySet(),
    /* A batch restore where some came back and some didn't: on screen until dismissed, retried, or Trash is left. */
    val restoreProblem: RestoreProblem? = null,
    /* Empty Trash under way: how many of the trash's items are gone so far, of how many. */
    val emptying: Pair<Int, Int>? = null,
    /* A pull on the trash list, the only thing its refresh ring stands for. */
    val refreshingTrash: Boolean = false,
    /* The last request could not reach the server; what is on the phone is shown. */
    val unreachable: Boolean = false,
    /* Folder ids (and "recents") being fetched right now. */
    val loading: Set<String> = emptySet(),
    /* Folders whose last load failed for a reason other than the network, so they can offer Try again. */
    val failedFolders: Set<String> = emptySet(),
    /* What this account shared, by node id; null until the server has said, so rows never guess. */
    val access: Map<String, Access>? = null,
    /* A place a notice's action asked to open ("phone": On this phone); the shell goes there and clears it. */
    val request: String? = null,
    /* The list of what others shared could not be loaded (and nothing was loaded before). */
    val sharesFailed: Boolean = false,
    /* A link that came in while signed out: it opens once this phone is signed in. */
    val linkWaiting: Boolean = false,
    /* The session ended on its own (a password changed elsewhere): said once over sign-in. */
    val signedOutNotice: Boolean = false,
    /* The account was just deleted: the last screen says so before sign-in. */
    val accountDeleted: Boolean = false,
    /* Searches made on this phone, newest first. */
    val recentSearches: List<String> = emptyList(),
) {
    /* Every item this session has opened, for search across folders. */
    val everything: List<Opened> get() = (folders.values.flatten() + recents).distinctBy { it.id }
    val emptyingTrash: Boolean get() = emptying != null
}

/*
 * A batch restore that partly failed: how many came back of how many, what didn't and why
 * (and whether the connection was the reason), and what went back to Files instead of its
 * folder, with that folder's name.
 */
data class RestoreProblem(
    val restored: Int, val total: Int,
    val failed: List<Pair<TrashItem, String>>, val offline: Boolean,
    val moved: List<Pair<Opened, String?>>,
)

/*
 * What the screens read: the gate, folder listings, recents and the trash,
 * refreshed after every write, plus thumbnails decrypted once and kept.
 */
class DriveViewModel(application: Application) : AndroidViewModel(application) {
    private val context: Context get() = getApplication()
    // The saved origin is read with the session below, off the main thread (the store's first open is Keystore work).
    private val _state = MutableStateFlow(DriveState(origin = defaultOrigin()))
    val state: StateFlow<DriveState> = _state
    private var vault: Vault? = null
    private val thumbnailTasks = HashSet<String>()

    private val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java)
    private val network = object : android.net.ConnectivityManager.NetworkCallback() {
        // The offline line follows the network, not the next failed request: back online, the lists catch up at once.
        override fun onAvailable(network: android.net.Network) {
            if (!state.value.unreachable) return
            _state.update { it.copy(unreachable = false) }
            viewModelScope.launch { sync() }
        }
        override fun onLost(network: android.net.Network) {
            // A switch from Wi-Fi to mobile loses one network while the other is already up: only no network at all is offline.
            viewModelScope.launch {
                kotlinx.coroutines.delay(500)
                if (connectivity.activeNetwork == null) _state.update { it.copy(unreachable = true) }
            }
        }
    }

    init {
        // A recovery kit left from a page that never closed (the app was stopped): it isn't kept.
        File(context.cacheDir, "kit").deleteRecursively()
        // Started without a network: say so at once rather than after the first request fails.
        if (connectivity.activeNetwork == null) _state.update { it.copy(unreachable = true) }
        runCatching { connectivity.registerDefaultNetworkCallback(network) }.onFailure { android.util.Log.w("HushOS", "network callback", it) }
        viewModelScope.launch {
            withContext(Dispatchers.IO) { Shared.origin(context) }?.let { origin -> _state.update { it.copy(origin = origin) } }
            val user = withContext(Dispatchers.IO) { runCatching { Auth.currentUser(context) } }
            when {
                user.isSuccess && user.getOrNull() != null -> signedIn(user.getOrNull()!!)
                user.isFailure && withContext(Dispatchers.IO) { Shared.session(context) } != null -> {
                    val session = withContext(Dispatchers.IO) { Shared.session(context) }!!
                    signedIn(SessionUser(session.userId, "", "", 0uL))
                }
                else -> _state.update { it.copy(gate = Gate.SIGNED_OUT) }
            }
        }
    }

    /* The Files app asks again: its root says signed in or out, and lists this account's drive. */
    private fun filesAppChanged() = context.contentResolver.notifyChange(android.provider.DocumentsContract.buildRootsUri("${context.packageName}.documents"), null)

    private fun signedIn(user: SessionUser) {
        // A session saved before the email was kept learns it now, so the Files app can name the account.
        if (user.email.isNotEmpty()) Shared.session(context)?.takeIf { it.email != user.email && it.userId == user.id }?.let {
            Shared.writeSession(context, it.copy(email = user.email))
        }
        // A session from before AccountStore: the data on the phone is this account's.
        com.hushos.app.data.AccountStore.of(context).adopt(user.id)
        vault = Vault.fromShared(context)
        filesAppChanged()
        refreshOffline()
        _state.update { it.copy(gate = Gate.SIGNED_IN, user = user, linkWaiting = false) }
        loadSearches()
        watchQueue()
        pendingLink?.let { link -> pendingLink = null; route(link) }
    }

    private var queueWatch: kotlinx.coroutines.Job? = null
    private val landed = HashSet<java.util.UUID>()
    /* Finished jobs the panel no longer shows: succeeded ones after a moment, failed ones once dismissed. */
    private val hiddenWork = MutableStateFlow(emptySet<java.util.UUID>())
    /* The queue as last seen, for the failed jobs' kept copies. */
    private var lastInfos: List<androidx.work.WorkInfo> = emptyList()
    /* Files a failed upload into a shared folder kept for its retry, by row. */
    private val stagedCopies = HashMap<String, File>()

    /*
     * The background queue as the panel shows it, and what a finished job changes:
     * a landed upload or keep redraws the lists. Once nothing is left to run, the
     * succeeded jobs leave the panel after a moment; a failed one stays with its
     * reason until it is dismissed or another transfer starts. WorkManager can only
     * prune every finished job at once, so that waits until none is left to read.
     */
    private fun watchQueue() {
        if (queueWatch != null) return
        val work = androidx.work.WorkManager.getInstance(context)
        queueWatch = viewModelScope.launch {
            kotlinx.coroutines.flow.combine(work.getWorkInfosByTagFlow(com.hushos.app.data.TransferQueue.TAG), hiddenWork, failedChanged) { infos, hidden, _ -> infos to hidden }.collectLatest { (infos, hidden) ->
                lastInfos = infos
                val inUse = infos.mapNotNull { info -> info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:")?.let { File(it).parent } }.toSet()
                val records = com.hushos.app.data.FailedTransfers.of(context)
                // Failures from before the app kept its own record go on it now, while WorkManager still has them.
                withContext(Dispatchers.IO) {
                    infos.filter { it.state == androidx.work.WorkInfo.State.FAILED && it.id !in hidden && !records.has(it.id.toString()) }.forEach { info ->
                        val tag = { prefix: String -> info.tags.firstOrNull { it.startsWith(prefix) }?.removePrefix(prefix) }
                        val out = info.outputData
                        records.record(com.hushos.app.data.FailedTransfer(info.id.toString(), tag("kind:") ?: "upload", tag("name:") ?: "File",
                            out.getString("message") ?: "The transfer failed.", System.currentTimeMillis(), out.getString("file") ?: tag("file:"), out.getString("mime"),
                            out.getString("folder"), out.getString("replacing"), tag("node:"), "folder" in info.tags, out.getString("share")))
                    }
                    com.hushos.app.data.TransferQueue.sweep(context, inUse)
                }
                // Failed rows come from the app's own record, which outlives WorkManager's; its FAILED jobs are not shown twice.
                val failedRows = withContext(Dispatchers.IO) { records.all() }.map { failed ->
                    TransferItem(
                        id = failed.id, kind = failed.kind, name = failed.name, fraction = 0f, done = true, failed = true,
                        message = if (failed.sourceGone()) "The file isn’t there any more. Pick it again." else failed.reason,
                        dismiss = { viewModelScope.launch(Dispatchers.IO) { com.hushos.app.data.TransferQueue.dismiss(context, failed); failedChanged.value++ } },
                        retry = if (failed.sourceGone()) null else ({ retryRecorded(failed) }),
                        node = failed.node, folder = failed.isFolder,
                    )
                }
                val shown = infos.filter { it.state != androidx.work.WorkInfo.State.CANCELLED && it.state != androidx.work.WorkInfo.State.FAILED && it.id !in hidden }
                val items = failedRows + shown.map { info ->
                    val tag = { prefix: String -> info.tags.firstOrNull { it.startsWith(prefix) }?.removePrefix(prefix) }
                    val file = tag("file:")
                    val finished = info.state.isFinished
                    val failed = info.state == androidx.work.WorkInfo.State.FAILED
                    TransferItem(
                        id = info.id.toString(), kind = tag("kind:") ?: "upload", name = tag("name:") ?: "File",
                        fraction = if (info.state == androidx.work.WorkInfo.State.SUCCEEDED) 1f else info.progress.getFloat("fraction", 0f),
                        done = finished, failed = failed,
                        waiting = info.state == androidx.work.WorkInfo.State.ENQUEUED || info.state == androidx.work.WorkInfo.State.BLOCKED,
                        cancel = if (finished) null else ({ com.hushos.app.data.TransferQueue.cancel(context, info.id, file) }),
                        message = if (failed) info.outputData.getString("message") ?: "The transfer failed." else null,
                        node = tag("node:"),
                        folder = "folder" in info.tags,
                        files = if ("folder" in info.tags && !finished && info.progress.getInt("total", -1) >= 0) info.progress.getInt("done", 0) to info.progress.getInt("total", 0) else null,
                    )
                }
                _state.update { it.copy(queued = items) }
                val newlyLanded = infos.filter { it.state == androidx.work.WorkInfo.State.SUCCEEDED && landed.add(it.id) }
                // A kept folder whose share stopped: its job removed the copies; the app says so.
                newlyLanded.mapNotNull { it.outputData.getString("unshared") }.forEach { name ->
                    notifyUntilRead("“$name” is no longer shared with you, so it was removed from this phone.")
                }
                // Its own coroutine: the next queue update must not cancel the refresh halfway.
                if (newlyLanded.isNotEmpty()) viewModelScope.launch { sync(); refreshOffline(); state.value.folders.keys.forEach { refresh(it) } }
                // Once nothing runs, the finished jobs go after a moment; failures live on in the app's own record.
                if (infos.isNotEmpty() && infos.all { it.state.isFinished }) {
                    if (shown.isNotEmpty()) kotlinx.coroutines.delay(4000)
                    work.pruneWork()
                }
            }
        }
    }

    /* Takes queued rows off the panel (finished ones; failures are the record's). */
    private fun forgetQueued(ids: Collection<java.util.UUID>) {
        if (ids.isEmpty()) return
        hiddenWork.update { it + ids }
    }

    /* Bumped when the failed-transfer record changes, so the panel reads it again. */
    private val failedChanged = MutableStateFlow(0)

    /* Sends a recorded failure again; its row makes way for the new job. */
    private fun retryRecorded(failed: com.hushos.app.data.FailedTransfer) = viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) { com.hushos.app.data.TransferQueue.retry(context, failed) }
        failedChanged.value++
        if (!ok) notify("The file to upload is gone. Pick it again.")
    }

    /* Takes in-app rows off the panel, and the copies failed ones kept. */
    private fun removeTransfers(which: (TransferItem) -> Boolean) {
        val gone = state.value.transfers.filter(which)
        gone.forEach { stagedCopies.remove(it.id)?.delete() }
        _state.update { s -> s.copy(transfers = s.transfers.filterNot(which)) }
    }

    /* Clear finished: rows that ended well leave the list; failures stay until removed or retried. */
    fun clearFinished() {
        forgetQueued(state.value.queued.filter { it.done && !it.failed }.map { java.util.UUID.fromString(it.id) })
        removeTransfers { it.done && !it.failed }
    }


    /* Whether a folder is in this account's own drive, where the background queue can reach it without the app. */
    private fun ownDrive(folderId: String): Boolean {
        val vault = vault ?: return false
        val root = state.value.rootId ?: return false
        val mine = vault.item(root)?.node?.workspaceId ?: return false
        return folderId == root || vault.item(folderId)?.node?.workspaceId == mine
    }

    fun addMenu(open: Boolean) = _state.update { it.copy(addMenuOpen = open) }

    fun setOrigin(origin: String) = _state.update { it.copy(origin = origin.trim().trimEnd('/')) }

    fun signIn(email: String, password: String, done: (String?) -> Unit) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Auth.signIn(context, state.value.origin, email, password) } }
            result.onSuccess { signedIn(it); done(null) }.onFailure { done(it.message ?: Auth.UNREACHABLE) }
        }
    }

    fun signOut() {
        // Queued transfers belong to the account signing out: stopped now; Auth.signOut removes
        // their copies with every other file of the account (AccountStore).
        androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(com.hushos.app.data.TransferQueue.TAG)
        queueWatch?.cancel(); queueWatch = null
        link = null
        vault = null
        _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin)
        viewModelScope.launch {
            withContext(Dispatchers.IO) { Auth.signOut(context) }
            filesAppChanged()
        }
    }

    private fun sessionLost() {
        Shared.clearSession(context)
        vault = null
        link = null
        _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin, signedOutNotice = true)
    }

    fun clearError() = _state.update { it.copy(error = null) }

    override fun onCleared() {
        runCatching { connectivity.unregisterNetworkCallback(network) }
        super.onCleared()
    }

    private fun begin(kind: String, name: String, node: String? = null): String {
        val id = java.util.UUID.randomUUID().toString()
        _state.update { it.copy(transfers = it.transfers + TransferItem(id, kind, name, 0f, node = node)) }
        return id
    }

    private fun progress(id: String, fraction: Float, name: String? = null) = _state.update { s ->
        s.copy(transfers = s.transfers.map { if (it.id == id) it.copy(fraction = fraction, name = name ?: it.name) else it })
    }

    private fun finish(id: String, failed: Boolean = false, message: String? = null, retry: (() -> Unit)? = null) {
        _state.update { s ->
            s.copy(transfers = s.transfers.map {
                if (it.id != id) it
                else it.copy(
                    done = true, failed = failed, fraction = if (failed) it.fraction else 1f,
                    message = if (failed) message ?: "The transfer failed." else null,
                    dismiss = if (failed) ({ drop(id) }) else null,
                    retry = if (failed) retry else null,
                )
            })
        }
        // Finished rows linger so the result is seen, then go once everything is done; a failure stays with its reason.
        viewModelScope.launch {
            kotlinx.coroutines.delay(4000)
            _state.update { s -> if (s.transfers.all { it.done }) s.copy(transfers = s.transfers.filter { it.failed }) else s }
        }
    }

    /* Takes a row off the panel: a failure dismissed, or a kept copy that only failed for being offline. */
    private fun drop(id: String) = removeTransfers { it.id == id }

    private suspend fun <T> quietly(block: (Vault) -> T): T? {
        val vault = vault ?: return null
        return try {
            withContext(Dispatchers.IO) { block(vault) }
        } catch (error: NotAuthenticated) {
            sessionLost(); null
        } catch (error: Unreachable) {
            _state.update { it.copy(unreachable = true) }; null
        } catch (error: Exception) {
            null
        }
    }

    /* With `failure`, a transfer's reason goes to its row in the panel instead of the error dialog. */
    /* The last failure `io` reported through a callback, for a caller that later shows it in the alert. */
    private var lastFailure: Throwable? = null

    private suspend fun <T> io(failure: ((String) -> Unit)? = null, block: (Vault) -> T): T? {
        val vault = vault ?: return null
        return try {
            withContext(Dispatchers.IO) { block(vault) }
        } catch (error: NotAuthenticated) {
            sessionLost()
            null
        } catch (error: Unreachable) {
            // No network: say so at the top rather than interrupting; kept files still open.
            _state.update { it.copy(unreachable = true) }
            failure?.invoke(error.message ?: "Could not reach HushOS.")
            null
        } catch (error: Exception) {
            val message = error.message ?: error.toString()
            lastFailure = error
            if (failure != null) failure(message) else _state.update { it.copy(error = com.hushos.app.data.Problems.of(error)) }
            null
        }
    }

    fun loadRoot() = viewModelScope.launch {
        if (state.value.rootId != null) return@launch
        io { it.rootId }?.let { id -> _state.update { it.copy(rootId = id) } }
        // The catalogue: the whole tree from the mirror on disk, then only the feed's changes.
        buildCatalogue()
    }

    /* Builds the catalogue once, then redraws every list from it. */
    private suspend fun buildCatalogue() {
        val ready = io { vault -> vault.buildCatalogue(); vault.catalogueState == CatalogueState.READY } ?: false
        if (!ready) return
        redraw(state.value.folders.keys)
        // The build took in every change since the last run, so every kept file is checked against it.
        refreshKept(Offline.entries(context).map { it.id }.toSet())
    }

    /* Pulls what changed since the cursor and redraws the lists it touched. */
    /*
     * Keeps lists current while the app is open, as the web polls its feed:
     * changes from other devices appear without a pull. Quiet: a failure here
     * never raises an alert, it only keeps or sets the offline line.
     */
    suspend fun liveSync() {
        if (state.value.gate != Gate.SIGNED_IN || vault == null) return
        sync(quiet = true)
    }

    private suspend fun sync(quiet: Boolean = false) {
        // Null: the server was not asked (no network, or the tree opened from the phone), so the offline line stays.
        val touched = (if (quiet) quietly { it.sync() } else io { it.sync() }) ?: return
        // The feed answered: whatever the last request said, the server is reachable now.
        if (state.value.unreachable) _state.update { it.copy(unreachable = false) }
        if (touched.isEmpty()) return
        redraw(state.value.folders.filter { (id, children) -> id in touched || children.any { it.id in touched } }.keys)
        refreshKept(touched)
    }

    private val refreshingKept = HashSet<String>()

    /*
     * A kept file changed elsewhere is brought up to date on its own, so a
     * refresh or an upload never waits for a large file to come down again.
     */
    private fun refreshKept(touched: Set<String>) {
        refreshKeptFolders()
        // A file that came with a kept folder is the folder's job, not one of its own.
        val kept = Offline.entries(context).filter { it.via == null && it.id in touched && it.id !in refreshingKept }
        if (kept.isEmpty()) return
        refreshingKept.addAll(kept.map { it.id })
        viewModelScope.launch {
            val ids = kept.map { it.id }
            val vault = vault
            // Only files whose copy is missing get a row: a rename or a tag moves nothing, and a file
            // this session cannot open yet (gone, or in a share not browsed) has nothing to fetch.
            val stale = withContext(Dispatchers.IO) {
                kept.filter { entry -> vault?.item(entry.id)?.let { !Offline.hasVersion(context, it) && it.node.trashedAt == null } ?: false }
            }
            val tickets = stale.associate { it.id to begin("keep", it.name) }
            var reason: String? = null
            val failed = io({ reason = it }) { v -> v.refreshOffline(ids) { id, fraction -> tickets[id]?.let { progress(it, fraction) } } }
            // Offline, the banner already says why; a row per kept file would only repeat it.
            tickets.forEach { (id, ticket) ->
                val failure = if (failed == null) reason ?: "Couldn't update the downloaded copy." else failed[id]?.let { it.message ?: "Couldn't update the downloaded copy." }
                if (failure != null && state.value.unreachable) drop(ticket)
                else finish(ticket, failed = failure != null, message = failure)
            }
            refreshingKept.removeAll(ids.toSet())
            refreshOffline()
        }
    }

    /*
     * A kept folder that changed (a file added, replaced, moved out or trashed, or the folder
     * itself gone) runs its keep job again: one job per folder, in the transfers panel.
     */
    /*
     * `withShares`: on foreground and pull to refresh, folders kept out of shares are looked at too,
     * through their shares (a few requests, so not on every tick), and a share that stopped takes
     * its kept copies with it.
     */
    private fun refreshKeptFolders(withShares: Boolean = false) {
        val folders = Offline.folders(context)
        if (folders.isEmpty()) return
        viewModelScope.launch {
            val shared = folders.filter { it.shareRoot != null }
            if (withShares && shared.isNotEmpty()) quietly { it.mountShares() }?.let { mounts -> dropUnshared(mounts) }
            val stale = quietly { vault ->
                Offline.folders(context).filter { (it.shareRoot == null || withShares) && vault.keptFolderStale(it.id, it.shareRoot) }
            } ?: return@launch
            for (folder in stale) com.hushos.app.data.TransferQueue.keep(context, folder.id, folder.name, folder = true, again = true, shareRoot = folder.shareRoot)
        }
    }

    /* Folders kept out of shares that stopped: their copies leave the phone, and the app says so. */
    private suspend fun dropUnshared(mounts: List<Vault.ShareMount>) {
        val gone = com.hushos.app.data.KeepRules.unshared(Offline.folders(context), mounts.map { it.share.node.id }.toSet())
        if (gone.isEmpty()) return
        withContext(Dispatchers.IO) { gone.forEach { Offline.forgetFolder(context, it.id) } }
        refreshOffline()
        notifyUntilRead(if (gone.size == 1) "“${gone[0].name}” is no longer shared with you, so it was removed from this phone." else "${gone.size} folders are no longer shared with you, so they were removed from this phone.")
    }

    /* The app came to the front: changes are picked up now rather than at the next tick. */
    fun onForeground() = viewModelScope.launch {
        if (state.value.gate != Gate.SIGNED_IN || vault == null) return@launch
        sync(quiet = true)
        refreshKeptFolders(withShares = true)
    }

    /* Retry on a file that couldn't be kept: its folder's failed files are tried again now. */
    fun retryKept(folderId: String) = viewModelScope.launch {
        val folder = Offline.folders(context).firstOrNull { it.id == folderId } ?: return@launch
        withContext(Dispatchers.IO) { Offline.retryFailures(context, folderId) }
        com.hushos.app.data.TransferQueue.keep(context, folder.id, folder.name, folder = true, again = true, shareRoot = folder.shareRoot)
        refreshOffline()
    }

    private suspend fun redraw(folderIds: Collection<String>) {
        val vault = vault ?: return
        val fresh = withContext(Dispatchers.IO) { folderIds.associateWith { runCatching { vault.listChildren(it) }.getOrNull() } }
        val recents = withContext(Dispatchers.IO) { runCatching { vault.recents() }.getOrNull() }
        _state.update { s -> s.copy(folders = s.folders + fresh.filterValues { it != null }.mapValues { it.value!! }, recents = recents ?: s.recents) }
    }

    fun refresh(folderId: String, pulled: Boolean = false) = viewModelScope.launch {
        _state.update { it.copy(loading = it.loading + folderId, failedFolders = it.failedFolders - folderId) }
        sync()
        // A pull also looks at kept folders now, shared ones included, rather than at the next tick.
        if (pulled) refreshKeptFolders(withShares = true)
        // A failure is the folder's own state (Try again), not an alert; offline has its own line.
        var failed: String? = null
        io({ failed = it }) { it.listChildren(folderId) }?.let { children -> _state.update { it.copy(folders = it.folders + (folderId to children)) } }
        _state.update {
            val shown = it.folders.containsKey(folderId)
            it.copy(
                loading = it.loading - folderId,
                failedFolders = if (failed != null && !it.unreachable && !shown) it.failedFolders + folderId else it.failedFolders,
                // A folder already on screen keeps its rows, so the failure is said the way it was before: in the alert.
                error = if (failed != null && !it.unreachable && shown) lastFailure?.let(com.hushos.app.data.Problems::of) else it.error,
            )
        }
    }

    /*
     * Who this account gave each item to, from its shares and live links, so rows
     * can say who can open them. Quiet: without it the rows only leave that out.
     */
    fun refreshAccess() = viewModelScope.launch {
        val now = java.time.Instant.now()
        val mine = quietly { it.api.sharedByMe() } ?: return@launch
        val (shares, links) = mine
        val people = shares.groupBy { it.second.id }.mapValues { (_, rows) ->
            rows.map { (share, _) -> firstName(share.granteeName, share.granteeEmail) to (share.role == "editor") }.distinctBy { it.first }
        }
        val ids = shares.groupBy { it.second.id }.mapValues { (_, rows) ->
            rows.associate { (share, _) -> firstName(share.granteeName, share.granteeEmail) to share.granteeId }
        }
        val open = links.filter { (link, _) -> link.expiresAt?.let { runCatching { java.time.Instant.parse(it).isAfter(now) }.getOrDefault(true) } ?: true }
            .groupingBy { it.second.id }.eachCount()
        _state.update { it.copy(access = (people.keys + open.keys).associateWith { id -> Access(people[id].orEmpty(), open[id] ?: 0, ids[id].orEmpty()) }) }
    }

    private fun firstName(name: String, email: String) = name.trim().split(' ').firstOrNull { it.isNotEmpty() } ?: email.substringBefore('@')

    /* Everything search can look through: the whole drive once the catalogue is built, else what this session opened. */
    fun searchable(): List<Opened> = vault?.takeIf { it.catalogueState == CatalogueState.READY }?.catalogueAll()?.takeIf { it.isNotEmpty() } ?: state.value.everything

    /* Whether search covers every folder (the catalogue is built) or only the ones opened here. */
    fun searchesEverything(): Boolean = vault?.catalogueState == CatalogueState.READY

    fun rememberSearch(query: String) {
        val q = query.trim()
        if (q.isEmpty()) return
        val list = (listOf(q) + state.value.recentSearches.filter { !it.equals(q, ignoreCase = true) }).take(6)
        _state.update { it.copy(recentSearches = list) }
        searchPrefs()?.edit()?.putString("recent", org.json.JSONArray(list).toString())?.apply()
    }

    /* Recent searches stay on this phone, per account, and go when it signs out. */
    private fun searchPrefs() = state.value.user?.id?.let { context.getSharedPreferences("search-$it", Context.MODE_PRIVATE) }

    private fun loadSearches() {
        val raw = searchPrefs()?.getString("recent", null) ?: return
        val list = runCatching { org.json.JSONArray(raw).let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrNull() ?: return
        _state.update { it.copy(recentSearches = list) }
    }

    fun clearRequest() = _state.update { it.copy(request = null) }

    /*
     * A launcher shortcut. Search opens Home's search; the others open the folder last added
     * to (or Files) and then run there as the + menu would. Signed out, the request waits
     * for sign-in, as a link does.
     */
    private var shortcutAction: String? = null
    fun shortcut(action: String) {
        if (action == "SEARCH") { openRequest("search"); return }
        if (action !in setOf("UPLOAD_FILES", "UPLOAD_PHOTOS", "NEW_FOLDER")) return
        shortcutAction = action
        openRequest("shortcut")
    }
    /* The shortcut's action, once its folder is open; taken once. */
    fun takeShortcut(): String? = shortcutAction.also { shortcutAction = null }

    /* The folder last added to, while it is still a folder of this drive (not in the trash); else null for Files. */
    suspend fun lastFolder(): String? {
        val id = com.hushos.app.data.Places.last(context)?.id ?: return null
        if (id == state.value.rootId) return null
        val item = find(id) ?: return null
        return id.takeIf { item.isFolder && item.node.trashedAt == null && ownDrive(id) }
    }
    fun openRequest(request: String) = _state.update { it.copy(request = request) }

    private var pendingLink: String? = null

    /*
     * A link the system handed the app (an https link to this server, or hushos://).
     * Signed out, it waits and opens after sign-in; otherwise it becomes a request
     * the screens act on: a tab, a folder, a file, or the link browser.
     */
    fun openLink(link: String) {
        // The emailed recovery link picks up recovery, signed in or not; it never waits for a sign-in.
        (com.hushos.app.data.AppLinks.parse(link, state.value.origin) as? com.hushos.app.data.AppLinkResult.Open)?.link?.let { target ->
            if (target is com.hushos.app.data.AppLink.Recover) { openRecoveryLink(target.verify); return }
        }
        if (state.value.gate != Gate.SIGNED_IN) {
            pendingLink = link
            _state.update { it.copy(linkWaiting = true) }
            return
        }
        route(link)
    }

    private fun route(link: String) {
        val origin = state.value.origin
        when (val result = com.hushos.app.data.AppLinks.parse(link, origin)) {
            is com.hushos.app.data.AppLinkResult.Open -> _state.update {
                it.copy(request = when (val target = result.link) {
                    com.hushos.app.data.AppLink.Home -> "home"
                    is com.hushos.app.data.AppLink.Files -> "files:${target.folder.orEmpty()}:${target.preview.orEmpty()}"
                    is com.hushos.app.data.AppLink.Shared -> "shared:${target.byMe}"
                    com.hushos.app.data.AppLink.Trash -> "trash"
                    is com.hushos.app.data.AppLink.Share -> "link:${target.url}"
                    // No key after the #: the link browser says the link is incomplete and asks for the whole one.
                    com.hushos.app.data.AppLink.IncompleteShare -> "link:${origin.trimEnd('/')}/s/"
                    is com.hushos.app.data.AppLink.Node -> "node:${target.id}"
                    is com.hushos.app.data.AppLink.Recover -> null
                })
            }
            is com.hushos.app.data.AppLinkResult.Refused -> when (val reason = result.reason) {
                is com.hushos.app.data.AppLinkRefusal.OtherServer ->
                    notify("That link is for another HushOS server (${reason.host}). This phone is signed in to ${hostOf(origin)}.")
                // Billing, pricing, the operator console, the website: said, never opened from here,
                // so the app holds no way to a page that sells plans (store payment rules).
                com.hushos.app.data.AppLinkRefusal.WebOnly -> notify("That page is only on the web.", action = "OK") {}
                com.hushos.app.data.AppLinkRefusal.Malformed -> notify("That link isn’t complete. Ask for it again, or copy the whole link.")
                com.hushos.app.data.AppLinkRefusal.Unsupported -> notify("That isn’t a HushOS link.")
            }
        }
    }

    private fun hostOf(origin: String) = runCatching { java.net.URI(origin).host }.getOrNull() ?: origin

    /*
     * Account recovery in the app, the web's /recover: email, the emailed link (which opens
     * the app), the kit (scanned, chosen as a file, or typed), a new password, then the new
     * phrase to save. Held here in memory only: the enrollment token never reaches saved
     * state or disk, and the flow goes when it finishes or is left.
     */
    enum class RecoveryStep { EMAIL, SENT, CHECKING, LINK_FAILED, KIT, NEW_PHRASE }

    data class RecoveryFlow(
        val step: RecoveryStep, val email: String = "", val enrollment: Auth.RecoveryEnrollment? = null,
        val pending: Boolean = false, val error: String? = null, val resent: Boolean = false, val newPhrase: String? = null,
    )

    internal var recovery by mutableStateOf<RecoveryFlow?>(null)
        private set

    fun startRecovery() { recovery = RecoveryFlow(RecoveryStep.EMAIL) }
    fun leaveRecovery() { recovery = null }
    fun clearRecoveryError() { recovery = recovery?.takeIf { it.error != null }?.copy(error = null) ?: recovery }
    fun recoveryBack() {
        if (recovery?.pending == true) return
        when (recovery?.step) {
            RecoveryStep.SENT, RecoveryStep.LINK_FAILED -> recoveryEmailAgain()
            RecoveryStep.CHECKING -> {}
            else -> leaveRecovery()
        }
    }
    fun recoveryEmailAgain() { recovery = RecoveryFlow(RecoveryStep.EMAIL, email = recovery?.email.orEmpty()) }

    fun sendRecoveryEmail(email: String, again: Boolean = false) {
        val address = email.trim()
        recovery = (recovery ?: RecoveryFlow(RecoveryStep.EMAIL)).copy(pending = true, error = null, email = address)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Auth.requestRecoveryEmail(state.value.origin, address) } }
            recovery = recovery?.let { flow ->
                result.fold(
                    { flow.copy(step = RecoveryStep.SENT, pending = false, resent = again) },
                    { flow.copy(pending = false, error = it.message ?: com.hushos.app.data.Problems.SERVER) },
                )
            }
        }
    }

    /* The emailed link: the address is confirmed and the kit comes next, or the link says why it can't be used. */
    fun openRecoveryLink(verify: String) {
        recovery = RecoveryFlow(RecoveryStep.CHECKING, email = recovery?.email.orEmpty())
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Auth.verifyRecoveryLink(state.value.origin, verify) } }
            recovery = result.fold(
                { RecoveryFlow(RecoveryStep.KIT, email = it.email, enrollment = it) },
                { RecoveryFlow(RecoveryStep.LINK_FAILED, error = it.message ?: "This link didn’t work.") },
            )
        }
    }

    /* The words and a new password: the reset, then a sign-in with the new password, then the new phrase to save. */
    fun recover(words: List<String>, password: String) {
        val flow = recovery ?: return
        val enrollment = flow.enrollment ?: return
        recovery = flow.copy(pending = true, error = null)
        viewModelScope.launch {
            val origin = state.value.origin
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val phrase = Auth.recover(origin, enrollment, words.joinToString(" "), password)
                    val user = try {
                        Auth.signIn(context, origin, enrollment.email, password)
                    } catch (error: Exception) {
                        throw com.hushos.app.data.AuthFailure("Your password was changed. Sign in with your new password.")
                    }
                    phrase to user
                }
            }
            result.fold(
                { (phrase, user) ->
                    recovery = RecoveryFlow(RecoveryStep.NEW_PHRASE, email = enrollment.email, newPhrase = phrase)
                    signedIn(user)
                },
                { recovery = recovery?.copy(pending = false, error = it.message ?: com.hushos.app.data.Problems.SERVER) },
            )
        }
    }

    /* An item by id for a link, from this phone's tree or asked of the server; null when it is gone or not this account's. */
    suspend fun find(id: String): Opened? {
        loadRoot().join()
        return quietly { vault -> vault.item(id) ?: runCatching { vault.resolve(id) }.getOrNull() }?.takeIf { it.node.trashedAt == null }
    }

    /* Opens a HushOS link in the Shared tab's link browser, from wherever it was pasted or retyped. */
    fun openLinkRequest(url: String) = _state.update { it.copy(request = "link:$url") }

    /* The link open in Shared, kept here so a rotation doesn't lock it again; see LinkSession. */
    internal var link by mutableStateOf<LinkSession?>(null)
        private set
    internal fun showLink(url: String) { if (link?.url != url) link = LinkSession(url, state.value.origin, viewModelScope) }
    internal fun closeLink() { link = null }

    fun refreshRecents(pulled: Boolean = false) = viewModelScope.launch {
        _state.update { it.copy(loading = it.loading + "recents") }
        loadRoot().join()
        sync()
        if (pulled) refreshKeptFolders(withShares = true)
        io { it.recents() }?.let { recents -> _state.update { it.copy(recents = recents) } }
        _state.update { it.copy(loading = it.loading - "recents") }
    }

    fun refreshTrash(pulled: Boolean = false) = viewModelScope.launch {
        if (pulled) { _state.update { it.copy(refreshingTrash = true) }; sync() }
        io { it.trash() }?.let { trash -> _state.update { it.copy(trash = trash) } }
        _state.update { it.copy(refreshingTrash = false) }
    }

    /* A trash row's action: a ring on the row while it runs, and the row gone the moment the server agrees. */
    private suspend fun onTrashRow(entry: TrashItem, action: (Vault) -> Unit): Boolean {
        val id = entry.item.id
        if (id in state.value.trashWorking) return false
        _state.update { it.copy(trashWorking = it.trashWorking + id) }
        val ok = write(null, block = action)
        _state.update { s -> s.copy(trashWorking = s.trashWorking - id, trash = if (ok) s.trash.filter { it.item.id != id } else s.trash) }
        if (ok) refreshTrash()
        return ok
    }

    fun refreshTags() = viewModelScope.launch {
        io { it.tags().first }?.let { tags -> _state.update { it.copy(tags = tags) } }
    }

    /* A change to the registry, saved a version up and reflected here. */
    fun editTags(change: (TagRegistry) -> Unit) = viewModelScope.launch {
        io { it.saveTags(change) }?.let { tags -> _state.update { it.copy(tags = tags) } }
    }

    /* The items a tag names, as far as this session can name them. */
    suspend fun tagged(tagId: String): List<Opened> {
        val ids = state.value.tags.nodesWith(tagId)
        val known = state.value.everything.associateBy { it.id }
        return io { vault -> ids.mapNotNull { id -> known[id] ?: runCatching { vault.resolve(id) }.getOrNull() } }.orEmpty()
            .sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    fun refreshShares() = viewModelScope.launch {
        _state.update { it.copy(loading = it.loading + "shares", sharesFailed = false) }
        var failed = false
        io({ failed = true }) { it.mountShares() }?.let { shares -> _state.update { it.copy(shares = shares) }; dropUnshared(shares) }
        _state.update { it.copy(loading = it.loading - "shares", sharesFailed = failed && it.shares == null) }
    }

    /* Started without a network, the account is known only by its id; once the server answers, its name and email fill in for the avatar. */
    fun refreshUser() = viewModelScope.launch {
        if (state.value.user?.email?.isNotEmpty() == true) return@launch
        withContext(Dispatchers.IO) { runCatching { Auth.currentUser(context) }.getOrNull() }?.let { user -> _state.update { it.copy(user = user) } }
    }

    fun refreshAccount() = viewModelScope.launch {
        val allowance = withContext(Dispatchers.IO) { runCatching { Auth.storage(context) }.getOrNull() }
        val billing = withContext(Dispatchers.IO) { runCatching { Auth.billing(context) }.getOrNull() }
        _state.update { it.copy(allowance = allowance, billing = billing) }
    }

    /* Account actions run off the main thread and report a message back; a lost session sends the person to sign in. */
    private fun account(block: () -> String?, done: (String?) -> Unit) = viewModelScope.launch {
        val result = withContext(Dispatchers.IO) { runCatching(block) }
        result.onSuccess { done(it) }.onFailure { failure ->
            if (failure is NotAuthenticated) sessionLost() else done(failure.message ?: com.hushos.app.data.Problems.SERVER)
        }
    }

    fun updateName(name: String, done: (String?) -> Unit) = account({
        val user = Auth.updateName(context, name)
        _state.update { it.copy(user = user) }
        null
    }, done)

    /* The links the owner made for an item, each with its URL when the secret was kept. */
    /* A link's address, rebuilt on this device from the copy of its secret the server keeps sealed. */
    suspend fun linkUrl(link: LinkView, item: Opened): String? = io { vault -> vault.linkUrlOf(link, item) }
    suspend fun links(item: Opened): List<Pair<LinkView, String?>>? = io { vault -> vault.links(item).map { it to runCatching { vault.linkUrlOf(it, item) }.getOrNull() } }
    suspend fun createLink(item: Opened, password: String?, expiresAt: java.time.Instant?): Pair<LinkView, String>? = io { it.createLink(item, password, expiresAt) }
    /* Turns a link off, then rotates the item's keys as the web does, so the old link's secret opens nothing new. */
    suspend fun revokeLink(link: LinkView, item: Opened): Boolean {
        io { it.revokeLink(link, item); true } ?: return false
        // Awaited, as after stopping a share: anything sealed next must use the item's new keys.
        // Re-securing what was shared happens quietly (it isn't a transfer); only a failure is said.
        var reason: String? = null
        val ok = io({ reason = it }) { vault -> vault.rotate(item); true } ?: false
        if (!ok) notify("Access stopped, but re-securing “${item.name}” didn’t finish. ${reason ?: "Check your connection."}")
        // The lists keep showing what they had while keys change underneath; then every folder on show is
        // read again from the feed. (Clearing them left a folder with nobody to reload it: an endless skeleton.)
        afterRotation()
        return true
    }
    suspend fun report(item: Opened, category: String, reason: String, email: String?): Boolean? = io { it.report(item, category, reason, email) }
    suspend fun recoveryPhrase(): String? = io { it.recoveryPhrase() }
    suspend fun contacts(): List<ContactPin>? = io { it.contacts() }
    suspend fun ownFingerprint(): String? = io { it.ownFingerprint() }
    suspend fun lookup(email: String): Result<Lookup> = withContext(Dispatchers.IO) { runCatching { (vault ?: throw NotAuthenticated()).lookup(email) } }
    suspend fun pin(contact: Contact): Boolean = io { it.pin(contact); true } ?: false
    suspend fun unpin(pin: ContactPin): Boolean = io { it.unpin(pin); true } ?: false
    suspend fun shares(item: Opened): List<OwnedShare>? = io { it.shares(item) }
    suspend fun sharedByMe(): List<SharedByMe>? = io { it.sharedByMe() }
    suspend fun share(item: Opened, pin: ContactPin, role: String): Result<OwnedShare> = withContext(Dispatchers.IO) { runCatching { (vault ?: throw NotAuthenticated()).share(item, pin, role) } }
    /* Revokes a share and, as the web does, rotates the subtree so the old key opens nothing new. */
    suspend fun revokeShare(share: OwnedShare, item: Opened): Boolean {
        val revoked = io { it.revokeShare(share, item); true } ?: return false
        // Re-securing what was shared happens quietly (it isn't a transfer); only a failure is said.
        var reason: String? = null
        val ok = io({ reason = it }) { vault -> vault.rotate(item); true } ?: false
        if (!ok) notify("Access stopped, but re-securing “${item.name}” didn’t finish. ${reason ?: "Check your connection."}")
        // The lists keep showing what they had while keys change underneath; then every folder on show is
        // read again from the feed. (Clearing them left a folder with nobody to reload it: an endless skeleton.)
        afterRotation()
        return revoked && ok
    }

    /* After keys rotated: the feed carries the re-sealed rows; every folder on show is listed again from them. */
    private suspend fun afterRotation() {
        // The lists keep plan.shown as they are; only the reload is acted on.
        val plan = afterAccessChange(state.value.folders)
        sync()
        redraw(plan.reload)
    }

    /* A master-key rotation ends every session too; the app signs in again and hands back the new phrase. */
    fun rotateKeys(password: String, done: (String?, String?) -> Unit) = viewModelScope.launch {
        val email = state.value.user?.email ?: return@launch
        val origin = state.value.origin
        val result = withContext(Dispatchers.IO) { runCatching { val phrase = Auth.rotateKeys(context, password); phrase to Auth.signIn(context, origin, email, password) } }
        result.onSuccess { (phrase, user) -> signedIn(user); done(phrase, null) }.onFailure { failure ->
            if (failure is NotAuthenticated) sessionLost() else done(null, failure.message ?: com.hushos.app.data.Problems.SERVER)
        }
    }

    /* The server ends every session on a password change, as on the web; the app signs in again with the new one. */
    fun changePassword(current: String, new: String, done: (String?) -> Unit) = viewModelScope.launch {
        val email = state.value.user?.email ?: return@launch
        val origin = state.value.origin
        val result = withContext(Dispatchers.IO) { runCatching { Auth.changePassword(context, current, new); Auth.signIn(context, origin, email, new) } }
        result.onSuccess { signedIn(it); done("Your password was changed.") }.onFailure { failure ->
            if (failure is NotAuthenticated) sessionLost() else done(failure.message ?: com.hushos.app.data.Problems.SERVER)
        }
    }

    fun deleteAccount(password: String, done: (String?) -> Unit) = account({
        Auth.deleteAccount(context, password)
        androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(com.hushos.app.data.TransferQueue.TAG)
        queueWatch?.cancel(); queueWatch = null
        link = null
        vault = null
        filesAppChanged()
        _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin, accountDeleted = true)
        null
    }, done)

    fun clearSignedOut() = _state.update { it.copy(signedOutNotice = false, accountDeleted = false) }

    /* The phrase, the recovery key for the kit file, and whether the phrase was confirmed as saved. */
    data class RecoveryKit(val phrase: String, val recovery: org.json.JSONObject, val confirmed: Boolean)

    suspend fun recoveryKit(): RecoveryKit? {
        val phrase = recoveryPhrase() ?: return null
        val (recovery, confirmed) = withContext(Dispatchers.IO) { runCatching { Auth.recoveryBackup(context) }.getOrNull() } ?: return null
        return RecoveryKit(phrase, recovery, confirmed)
    }

    /* After the check: the server records that this phrase was saved. */
    suspend fun confirmRecovery(kit: RecoveryKit): Boolean =
        withContext(Dispatchers.IO) { runCatching { Auth.confirmRecovery(context, kit.recovery.getLong("recoveryVersion")) }.isSuccess }

    /* Removes every earlier version now; files keep their current one. */
    suspend fun discardEarlierVersions(): Boolean {
        // A batch at a time, as emptying the trash goes, until nothing is left or nothing moves.
        val ok = io { vault ->
            var step = vault.api.discardSuperseded(vault.workspaceId)
            while (step.remaining > 0 && step.purged > 0) step = vault.api.discardSuperseded(vault.workspaceId)
            true
        } ?: false
        refreshStorage(); refreshAccount()
        return ok
    }

    fun refreshStorage() = viewModelScope.launch {
        io { it.api.storage(it.workspaceId) }?.let { storage -> _state.update { it.copy(storage = storage) } }
    }

    fun thumbnail(item: Opened) {
        if (!item.hasThumbnail || state.value.thumbnails.containsKey(item.id) || !thumbnailTasks.add(item.id)) return
        viewModelScope.launch {
            val vault = vault ?: return@launch
            val bytes = withContext(Dispatchers.IO) { runCatching { vault.thumbnail(item.id) }.getOrNull() }
            if (bytes != null) _state.update { it.copy(thumbnails = it.thumbnails + (item.id to bytes)) }
            thumbnailTasks.remove(item.id)
        }
    }

    private suspend fun write(folder: String?, failure: ((String) -> Unit)? = null, block: (Vault) -> Unit): Boolean {
        _state.update { it.copy(busy = true) }
        val ok = io(failure) { block(it); true } ?: false
        // Offline the write did not happen: say so plainly rather than failing without a word (a transfer's row says it).
        if (!ok && failure == null && state.value.unreachable) notify("You’re offline, so that didn’t happen. Try again once you’re connected.")
        // The catalogue answers listings, so pull the feed first: the write is in it already.
        if (ok) sync()
        if (ok && folder != null) io { it.listChildren(folder) }?.let { children -> _state.update { it.copy(folders = it.folders + (folder to children)) } }
        _state.update { it.copy(busy = false) }
        if (ok) context.contentResolver.notifyChange(android.provider.DocumentsContract.buildRootsUri("${context.packageName}.documents"), null)
        // A change made here inside a kept folder of a share isn't in this drive's feed: look at those now too.
        if (ok && Offline.folders(context).any { it.shareRoot != null }) refreshKeptFolders(withShares = true)
        return ok
    }

    fun createFolder(name: String, folder: String) = viewModelScope.launch { write(folder) { it.createFolder(folder, name) } }
    fun rename(item: Opened, name: String) = viewModelScope.launch { write(item.node.parentId) { it.rename(item.id, name) } }
    fun move(item: Opened, folder: String) = viewModelScope.launch {
        if (write(item.node.parentId) { it.move(item.id, folder) }) refresh(folder)
    }
    fun copy(items: List<Opened>) = _state.update { it.copy(clipboard = items to false) }
    fun cut(items: List<Opened>) = _state.update { it.copy(clipboard = items to true) }
    fun clearClipboard() = _state.update { it.copy(clipboard = null) }

    /* Cut items move; copied ones are duplicated, folder trees node by node. */
    fun paste(folder: String) = viewModelScope.launch {
        val (all, cut) = state.value.clipboard ?: return@launch
        if (!canPaste(folder)) return@launch
        _state.update { it.copy(clipboard = null) }
        // What is already here stays as it is; only the rest comes over.
        val items = all.filter { it.node.parentId != folder }
        val targetWorkspace = io { it.item(folder)?.node?.workspaceId } ?: items.first().node.workspaceId
        for ((index, item) in items.withIndex()) {
            val sameDrive = item.node.workspaceId == targetWorkspace
            if (cut && sameDrive) { move(item, folder).join(); continue }
            val ticket = begin("copy", item.name)
            var reason: String? = null
            if (sameDrive) finish(ticket, failed = !write(folder, { reason = it }) { it.copy(item.id, folder) }, message = reason)
            else {
                // Across drives (into a shared folder) the object is fetched and uploaded again; a cut then trashes the original.
                val ok = write(folder, { reason = it }) { vault -> vault.copyAcross(item.id, folder) { fraction -> progress(ticket, fraction) } }
                finish(ticket, failed = !ok, message = reason)
                if (ok && cut) trash(item).join()
            }
        }
    }

    fun trashAll(items: List<Opened>) = viewModelScope.launch {
        for (item in items) trashOne(item)
        announceTrash(items)
    }

    /* Says what went to the trash and offers to bring it straight back. */
    private fun announceTrash(items: List<Opened>) {
        val text = if (items.size == 1) "Moved “${items[0].name}” to Trash" else "Moved ${items.size} items to Trash"
        notify(text) { viewModelScope.launch { for (item in items) restoreQuietly(item) } }
    }

    /*
     * A file no app on this phone opens. The board's viewer would say "This kind of file has
     * no preview yet"; Android has no viewer, so it says no app opens it and offers Send a copy
     * (the file is already here, so the share sheet opens at once).
     */
    fun noApp(name: String, uri: Uri, mime: String?) = notify("No app on this phone opens “$name”. Send a copy to open it somewhere else.", action = "Send a copy") {
        val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType(mime ?: "*/*").putExtra(android.content.Intent.EXTRA_STREAM, uri)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { context.startActivity(shareChooser(context, send, name).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    fun notify(text: String, action: String = "Undo", undo: (() -> Unit)? = null) {
        val notice = Notice(System.nanoTime(), text, undo, action)
        _state.update { it.copy(notice = notice) }
        viewModelScope.launch {
            kotlinx.coroutines.delay(6000)
            _state.update { if (it.notice?.id == notice.id) it.copy(notice = null) else it }
        }
    }

    /* A notice that stays until it is read: something left the phone without being asked to. OK closes it. */
    fun notifyUntilRead(text: String) = _state.update { it.copy(notice = Notice(System.nanoTime(), text, {}, "OK")) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    private suspend fun restoreQuietly(item: Opened) {
        if (write(item.node.parentId) { it.restore(TrashItem(item, false)) }) refreshRecents()
    }
    /*
     * Move to…: within a drive the item's key is wrapped again under its new folder.
     * Into (or out of) a folder someone shared, the server keeps objects per drive,
     * so it is copied across (fetched and uploaded again, as Paste does) and the
     * original then goes to the Trash: what Cut and Paste did, through the picker.
     */
    fun moveAll(items: List<Opened>, folder: String, folderName: String) = viewModelScope.launch {
        val moving = items.filter { it.node.parentId != folder && it.id != folder }
        if (moving.isEmpty()) return@launch
        val targetWorkspace = io { it.item(folder)?.node?.workspaceId } ?: moving.first().node.workspaceId
        val back = ArrayList<Pair<Opened, String>>()
        var failed = 0
        for (item in moving) {
            if (item.node.workspaceId == targetWorkspace) {
                if (write(item.node.parentId) { it.move(item.id, folder) }) item.node.parentId?.let { back.add(item to it) } else failed++
                continue
            }
            val ticket = begin("copy", item.name)
            var reason: String? = null
            val ok = write(folder, { reason = it }) { vault -> vault.copyAcross(item.id, folder) { fraction -> progress(ticket, fraction) } }
            finish(ticket, failed = !ok, message = reason)
            if (ok) trashOne(item) else failed++
        }
        refresh(folder)
        val moved = moving.size - failed
        if (moved == 0) return@launch
        val text = if (moving.size == 1) "Moved “${moving[0].name}” to “$folderName”" else "Moved $moved items to “$folderName”"
        // Only a move inside one drive can be taken back exactly; a copy across drives has a new identity.
        if (back.size == moved) notify(text) { viewModelScope.launch { for ((item, parent) in back) write(folder) { it.move(item.id, parent) }; refresh(folder) } }
        else notify(text)
    }

    /*
     * Save a copy to my Drive: something shared with this account is read through
     * the share's key and uploaded again under the account's own keys, into the top
     * folder, under a name that is free there.
     */
    fun saveCopy(items: List<Opened>) = viewModelScope.launch {
        val root = state.value.rootId ?: io { it.rootId } ?: return@launch
        val taken = (io { it.listChildren(root) } ?: emptyList()).map { it.name.lowercase() }.toMutableSet()
        for (item in items) {
            val name = freeName(item.name, taken).also { taken.add(it.lowercase()) }
            val ticket = begin("copy", item.name)
            var reason: String? = null
            val ok = write(root, { reason = it }) { vault -> vault.copyAcross(item.id, root, name) { fraction -> progress(ticket, fraction) } }
            finish(ticket, failed = !ok, message = reason)
        }
        if (items.size == 1) notify("Saving a copy of “${items[0].name}”. It shows up in Files as it copies.")
    }

    /* The same, from a link someone opened here: read through the link, uploaded under this account's keys. */
    fun saveLinkCopy(link: com.hushos.app.data.LinkVault, item: Opened) = viewModelScope.launch {
        val root = state.value.rootId ?: io { it.rootId } ?: return@launch
        val taken = (io { it.listChildren(root) } ?: emptyList()).map { it.name.lowercase() }.toSet()
        val ticket = begin("copy", item.name)
        var reason: String? = null
        notify("Saving a copy of “${item.name}”. It shows up in Files as it copies.")
        val ok = write(root, { reason = it }) { vault -> copyFromLink(vault, link, item, root, freeName(item.name, taken)) }
        finish(ticket, failed = !ok, message = reason)
    }

    private fun copyFromLink(vault: Vault, link: com.hushos.app.data.LinkVault, item: Opened, parent: String, name: String) {
        if (item.isFolder) {
            val made = vault.createFolder(parent, name)
            for (child in link.children(item.id)) copyFromLink(vault, link, child, made.id, child.name)
            return
        }
        val directory = File(context.cacheDir, "copy-" + java.util.UUID.randomUUID())
        try {
            val file = File(directory, name)
            link.download(item, file)
            vault.upload(file, name, item.metadata.mime, parent, null, vault.makeThumbnail(file, item.metadata.mime))
        } finally {
            directory.deleteRecursively()
        }
    }

    /* A link's password and end date; the address stays the same. */
    suspend fun updateLink(link: LinkView, item: Opened, password: String?, expiresAt: java.util.Optional<java.time.Instant>?): Boolean =
        io { it.updateLink(link, item, password, expiresAt); true } ?: false

    /* Deletes an earlier version for good. */
    suspend fun discardVersion(item: Opened, version: VersionListView): Boolean {
        val ok = io { it.discardVersion(item, version); true } ?: false
        if (ok) refreshStorage()
        return ok
    }

    fun trash(item: Opened) = viewModelScope.launch {
        if (trashOne(item)) announceTrash(listOf(item))
    }

    private suspend fun trashOne(item: Opened): Boolean {
        val ok = write(item.node.parentId) { it.trash(item.id) }
        _state.update { s -> s.copy(recents = s.recents.filter { it.id != item.id }) }
        return ok
    }
    fun restore(entry: TrashItem) = viewModelScope.launch {
        if (!onTrashRow(entry) { it.restore(entry) }) return@launch
        // Its folder still in the trash, it went to the top.
        notify("Restored “${entry.item.name}” to ${if (entry.parentTrashed) "Files" else entry.wasIn ?: "its folder"}")
        (if (entry.parentTrashed) state.value.rootId else entry.item.node.parentId)?.let { if (state.value.folders.containsKey(it)) refresh(it) }
    }
    fun purge(entry: TrashItem) = viewModelScope.launch {
        if (onTrashRow(entry) { it.purge(entry.item.id) }) notify("Deleted “${entry.item.name}” forever")
    }

    /* The folders above `id`, nearest first, as far as the catalogue knows them. */
    private fun ancestors(vault: Vault, id: String): List<Opened> {
        val chain = ArrayList<Opened>()
        var cursor = vault.item(id)?.node?.parentId
        while (cursor != null && chain.size < 256) {
            val parent = vault.item(cursor) ?: break
            chain.add(parent)
            cursor = parent.node.parentId
        }
        return chain
    }

    /*
     * Restores several trash rows. Shallowest first, so a folder comes back before
     * what was trashed inside it; a row whose trashed folders all came back in this
     * batch goes home, one whose folder is still in the trash goes to the top.
     */
    fun restoreMany(entries: List<TrashItem>) = viewModelScope.launch {
        val vault = vault ?: return@launch
        val chains = withContext(Dispatchers.IO) { entries.associate { it.item.id to ancestors(vault, it.item.id) } }
        val ordered = entries.sortedBy { chains[it.item.id]?.size ?: 0 }
        val back = HashSet<String>()
        val failed = ArrayList<Pair<TrashItem, String>>()
        val moved = ArrayList<Pair<Opened, String?>>()
        var offline = false
        _state.update { it.copy(restoreProblem = null, trashWorking = it.trashWorking + entries.map { e -> e.item.id }) }
        for (entry in ordered) {
            val home = chains[entry.item.id].orEmpty().filter { it.node.trashedAt != null }.all { it.id in back }
            var why = "Try again."
            val ok = write(null, { why = it }) { it.restore(entry.copy(parentTrashed = !home)) }
            if (!ok && state.value.unreachable) offline = true
            _state.update { s -> s.copy(trashWorking = s.trashWorking - entry.item.id, trash = if (ok) s.trash.filter { it.item.id != entry.item.id } else s.trash) }
            if (ok) { back.add(entry.item.id); if (!home) moved.add(entry.item to entry.wasIn) } else failed.add(entry to why)
        }
        sync()
        refreshTrash().join()
        redraw(state.value.folders.keys)
        val restored = entries.size - failed.size
        // Some didn't come back: a banner that stays, saying which, why and what to do (the board's), not a passing notice.
        if (failed.isNotEmpty()) {
            _state.update { it.copy(restoreProblem = RestoreProblem(restored, entries.size, failed, offline, moved)) }
            return@launch
        }
        // One item (a Try again from the banner, say): where it went, as a single restore says it.
        if (entries.size == 1) {
            val entry = entries[0]
            notify("Restored “${entry.item.name}” to ${if (moved.isNotEmpty()) "Files" else entry.wasIn ?: "its folder"}")
            return@launch
        }
        var text = "$restored items restored"
        if (moved.isNotEmpty()) text += if (moved.size == 1) ". One went back to Files: its folder is still in the Trash." else ". ${moved.size} went back to Files: their folders are still in the Trash."
        notify(text)
    }

    fun clearRestoreProblem() = _state.update { it.copy(restoreProblem = null) }

    /* Deletes several trash rows forever; what sits inside a picked folder goes with it, so it is not asked for twice. */
    fun purgeMany(entries: List<TrashItem>) = viewModelScope.launch {
        val vault = vault ?: return@launch
        val picked = entries.map { it.item.id }.toSet()
        val inside = withContext(Dispatchers.IO) { entries.filter { e -> ancestors(vault, e.item.id).any { it.id in picked } }.map { it.item.id }.toSet() }
        val tops = entries.filter { it.item.id !in inside }
        var failed = 0
        _state.update { it.copy(trashWorking = it.trashWorking + picked) }
        for (entry in tops) {
            val ok = write(null, { }) { it.purge(entry.item.id) }
            _state.update { s -> s.copy(trashWorking = s.trashWorking - entry.item.id, trash = if (ok) s.trash.filter { it.item.id != entry.item.id } else s.trash) }
            if (!ok) failed++
        }
        _state.update { it.copy(trashWorking = it.trashWorking - picked) }
        sync()
        refreshTrash().join()
        notify(if (failed > 0) "$failed of ${tops.size} could not be deleted" else if (entries.size == 1) "1 item deleted forever" else "${entries.size} items deleted forever")
    }

    /*
     * Empty Trash: the rows on screen go one at a time (what sits inside a trashed folder
     * goes with it), so the bar can say "3 of 12"; then the server's batches take whatever
     * the list didn't show, again until nothing is left or nothing moves, as the web asks it.
     */
    fun emptyTrash() = viewModelScope.launch {
        if (state.value.emptyingTrash) return@launch
        val vault = vault ?: return@launch
        val rows = state.value.trash
        val ids = rows.map { it.item.id }.toSet()
        val inside = withContext(Dispatchers.IO) { rows.filter { e -> ancestors(vault, e.item.id).any { it.id in ids } }.map { it.item.id }.toSet() }
        val tops = rows.filter { it.item.id !in inside }
        _state.update { it.copy(emptying = 0 to tops.size) }
        var failed = 0
        for ((index, entry) in tops.withIndex()) {
            _state.update { it.copy(trashWorking = it.trashWorking + entry.item.id) }
            val ok = write(null, { }) { it.purge(entry.item.id) }
            _state.update { s ->
                s.copy(trashWorking = s.trashWorking - entry.item.id, emptying = index + 1 to tops.size,
                    trash = if (ok) s.trash.filter { it.item.id != entry.item.id && !(it.item.id in inside && ancestors(vault, it.item.id).any { a -> a.id == entry.item.id }) } else s.trash)
            }
            if (!ok) { failed++; if (state.value.unreachable) break }
        }
        var result: com.hushos.app.data.EmptyTrashResult? = null
        if (failed == 0) do {
            var step: com.hushos.app.data.EmptyTrashResult? = null
            if (!write(null) { step = it.emptyTrash() }) break
            result = step
        } while (result != null && result.remaining > 0 && result.purged > 0)
        sync()
        refreshTrash().join()
        _state.update { it.copy(emptying = null) }
        when {
            failed == 0 && result?.remaining == 0 -> notify("Trash emptied")
            state.value.unreachable -> Unit
            state.value.trash.isNotEmpty() -> notify("Some items are still in the Trash. Try Empty Trash again.")
        }
    }
    fun restoreVersion(version: VersionListView, item: Opened) = viewModelScope.launch { write(item.node.parentId) { it.restoreVersion(version, item.id) } }
    /* The same, for a caller that waits to say how it went. */
    suspend fun restoreVersionNow(version: VersionListView, item: Opened): Boolean = write(item.node.parentId) { it.restoreVersion(version, item.id) }

    /* Who a report lets look: the HushOS team on hushos.com, or the people who run a self-hosted server. */
    fun reportsGoTo(state: DriveState): String = if (state.origin.removePrefix("https://").removePrefix("www.").startsWith("hushos.com")) "the HushOS team" else "the people who run this server"

    suspend fun versions(item: Opened): List<VersionListView> = io { it.versions(item.id) } ?: emptyList()

    /* Each version's size, from its sealed envelope; a version that will not open here is left out. */
    suspend fun versionSizes(item: Opened, versions: List<VersionListView>): Map<String, Long> = quietly { vault ->
        versions.mapNotNull { v -> runCatching { v.id to vault.openVersion(item, v).content.plaintextSize.toLong() }.getOrNull() }.toMap()
    } ?: emptyMap()

    /* What to do with a picked file whose name a file in the folder already has, as the web asks. */
    enum class Conflict { REPLACE, KEEP_BOTH, SKIP }

    fun displayName(uri: Uri): String? {
        var name: String? = uri.lastPathSegment?.substringAfterLast('/')
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0)?.let { name = it }
        }
        return name
    }

    /* "report.pdf" becomes "report (2).pdf", then "(3)", until the name is free. */
    fun freeName(name: String, taken: Set<String>): String {
        if (name.lowercase() !in taken) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        for (n in 2..999) { val candidate = "$stem ($n)$ext"; if (candidate.lowercase() !in taken) return candidate }
        return "$stem ${System.nanoTime() % 100000}$ext"
    }

    /* Files picked with the system picker, copied into the cache and uploaded in turn with their thumbnails. */
    /* Pasting into the folder the items already sit in is a no-op the drives refuse; so do we. */
    fun canPaste(folder: String): Boolean = pasteProblem(folder) == null

    /* Why the clipboard cannot go into this folder, or null when it can. */
    fun pasteProblem(folder: String): String? {
        val items = state.value.clipboard?.first ?: return "Nothing to paste"
        val vault = vault
        if (vault != null && items.any { it.isFolder && vault.descends(folder, it.id) }) return "Can’t paste a folder into itself"
        return if (items.any { it.node.parentId != folder }) null else if (items.size == 1) "It’s already in this folder" else "They’re already in this folder"
    }

    fun upload(uris: List<Uri>, folder: String, onConflict: Conflict = Conflict.KEEP_BOTH, renames: Map<String, String> = emptyMap()) = viewModelScope.launch {
        // The folder last added to: Save to HushOS and the shortcuts start there next time.
        if (ownDrive(folder)) com.hushos.app.data.Places.used(context, folder, if (folder == state.value.rootId) "Files" else vault?.item(folder)?.name ?: "Files")
        val existing = (state.value.folders[folder] ?: emptyList()).filter { !it.isFolder }
        val taken = existing.map { it.name.lowercase() }.toSet()
        for ((index, uri) in uris.withIndex()) {
            val staged = withContext(Dispatchers.IO) { stage(uri) } ?: continue
            val clash = existing.firstOrNull { it.name.equals(staged.second, ignoreCase = true) }
            var name = staged.second
            var replacing: Opened? = null
            if (clash != null) when (onConflict) {
                Conflict.SKIP -> { staged.first.delete(); continue }
                Conflict.REPLACE -> replacing = clash
                Conflict.KEEP_BOTH -> name = renames[name] ?: freeName(name, taken)
            }
            if (ownDrive(folder)) {
                // Queued: it waits for a network and finishes even if the app is closed; the panel shows it.
                com.hushos.app.data.TransferQueue.upload(context, staged.first, name, staged.third, folder, replacing?.id)
                continue
            }
            // A shared folder lives in someone else's drive: uploaded here and now, as before.
            if (!uploadNow(staged.first, name, staged.third, folder, replacing)) break
        }
    }

    /* A photo the camera app wrote into the cache: uploaded like a picked file, then its cache copy goes. */
    fun uploadTaken(file: File, folder: String) = viewModelScope.launch {
        upload(listOf(FileProvider.getUriForFile(context, "${context.packageName}.shared", file)), folder).join()
        file.delete()
    }

    /* Uploads a staged file here and now; a failure keeps the file, so its row can send it again. */
    private suspend fun uploadNow(file: File, name: String, mime: String?, folder: String, replacing: Opened?): Boolean {
        val ticket = begin("upload", name)
        var reason: String? = null
        val ok = write(folder, { reason = it }) { vault ->
            vault.upload(file, name, mime, folder, replacing, vault.makeThumbnail(file, mime)) { fraction -> progress(ticket, fraction) }
        }
        if (ok) {
            file.delete()
            finish(ticket)
        } else {
            stagedCopies[ticket] = file
            finish(ticket, failed = true, message = reason, retry = {
                // The copy moves to the new row, so taking this one off must not delete it.
                stagedCopies.remove(ticket)
                drop(ticket)
                viewModelScope.launch { if (file.exists()) uploadNow(file, name, mime, folder, replacing) else notify("Couldn’t find “$name” to upload. Choose it again.") }
            })
        }
        return ok
    }

    private fun stage(uri: Uri): Triple<File, String, String?>? {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0)?.let { name = it }
        }
        val target = File(context.cacheDir, "staged/${System.nanoTime()}/$name").also { it.parentFile?.mkdirs() }
        resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } } ?: return null
        return Triple(target, name, resolver.getType(uri))
    }

    /* Decrypts to a cache file named as the user sees it; the FileProvider hands it to viewers and the share sheet. */
    /* Keep downloaded on or off: the local copy comes or goes. */
    fun setKeptDownloaded(item: Opened, keep: Boolean) = viewModelScope.launch {
        // A folder: one queued job keeps everything in it; removing it removes all of that.
        if (item.isFolder) {
            if (keep) {
                // Out of a share: the share's root, found among the shares received, so the job can reach it.
                val shareRoot = if (item.node.workspaceId == vault?.item(state.value.rootId ?: "")?.node?.workspaceId) null else {
                    val mounts = state.value.shares ?: quietly { it.mountShares() }.orEmpty()
                    mounts.mapNotNull { it.root }.firstOrNull { root -> root.id == item.id || vault?.descends(item.id, root.id) == true }?.id
                }
                com.hushos.app.data.TransferQueue.keep(context, item.id, item.name, folder = true, shareRoot = shareRoot)
            }
            else {
                androidx.work.WorkManager.getInstance(context).cancelUniqueWork("keep-${item.id}")
                withContext(Dispatchers.IO) { Offline.forgetFolder(context, item.id) }
            }
            refreshOffline()
            return@launch
        }
        if (keep && item.node.parentId != null && ownDrive(item.node.parentId)) {
            // Queued like an upload: kept once there is a network, whether or not the app is open.
            com.hushos.app.data.TransferQueue.keep(context, item.id, item.name)
        } else if (keep) {
            if (state.value.transfers.any { it.kind == "keep" && it.node == item.id && !it.done }) return@launch
            val ticket = begin("keep", item.name, item.id)
            var reason: String? = null
            val ok = io({ reason = it }) { vault -> vault.keepDownloaded(item) { fraction -> progress(ticket, fraction) }; true } ?: false
            finish(ticket, failed = !ok, message = reason)
        } else Offline.forget(context, item.id)
        refreshOffline()
    }

    fun refreshOffline() = _state.update { it.copy(offline = Offline.entries(context), keptFolders = Offline.folders(context), keepFailures = Offline.failures(context)) }

    /* The kept folder an item sits in, if any (the item itself not counted). */
    fun keptFolderOf(item: Opened, state: DriveState): Offline.Folder? {
        val parent = item.node.parentId ?: return null
        val vault = vault ?: return null
        return state.keptFolders.firstOrNull { vault.descends(parent, it.id) }
    }

    /* Whether a row shows the kept mark: a kept file or folder, a file that came with one, or a folder inside a kept one. */
    fun keptMark(item: Opened, state: DriveState): Boolean {
        if (state.keptFolders.any { it.id == item.id } || state.offline.any { it.id == item.id }) return true
        if (!item.isFolder || state.keptFolders.isEmpty()) return false
        val vault = vault ?: return false
        return state.keptFolders.any { vault.descends(item.id, it.id) }
    }

    /* The opened item for an id, when this session knows it (the catalogue opens the whole drive). */
    fun item(id: String): Opened? = vault?.item(id)

    /* A kept folder off the phone (from one of its files, or On this phone): everything that came with it goes. */
    fun forgetKeptFolder(id: String) = viewModelScope.launch {
        androidx.work.WorkManager.getInstance(context).cancelUniqueWork("keep-$id")
        withContext(Dispatchers.IO) { Offline.forgetFolder(context, id) }
        refreshOffline()
    }

    fun forgetOffline(id: String) {
        Offline.forget(context, id)
        refreshOffline()
    }

    /* `quiet`: a caller that says itself what went wrong (Send a copy) gets no offline notice. */
    suspend fun download(item: Opened, version: VersionListView? = null, quiet: Boolean = false): Uri? {
        if (version == null) Offline.localCopy(context, item)?.let { return FileProvider.getUriForFile(context, "${context.packageName}.shared", it) }
        // Opening a file is not a transfer to announce: the row shows a small ring while it comes down.
        _state.update { it.copy(opening = it.opening + (item.id to 0f)) }
        // Keyed by the version itself, so a file replaced elsewhere is fetched again rather than served from an old copy.
        val file = File(context.cacheDir, "opened/${item.id}/${version?.id ?: item.node.currentVersion?.id ?: "current"}/${item.name}")
        var reason: String? = null
        val ok = if (file.exists()) true else io({ reason = it }) { vault ->
            vault.download(item.id, file, version) { fraction -> _state.update { it.copy(opening = it.opening + (item.id to fraction)) } }
            true
        } ?: false
        _state.update { it.copy(opening = it.opening - item.id) }
        // A failure is said on a notice, not an alert: the row it came from is still there to try again.
        if (!ok && !quiet && !state.value.unreachable) notify("Couldn’t open “${item.name}”. ${reason ?: "Try again."}")
        if (!ok && !quiet && state.value.unreachable) notify("You’re offline. Files you keep on this phone open without a connection.", action = "Show") { _state.update { it.copy(request = "phone") } }
        return if (ok) FileProvider.getUriForFile(context, "${context.packageName}.shared", file) else null
    }
}

/*
 * The server this build talks to unless the person changes it: the dev server for debug
 * builds, production for release (build.gradle.kts), the same origin its links answer to.
 */
internal fun defaultOrigin(): String = BuildConfig.DEFAULT_ORIGIN
