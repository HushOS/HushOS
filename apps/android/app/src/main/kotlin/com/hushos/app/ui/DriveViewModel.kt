package com.hushos.app.ui

import android.app.Application
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hushos.app.BuildConfig
import com.hushos.app.data.Auth
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

/* A short line after an action, with a way to take it back: "Moved 2 items to trash · Undo". */
data class Notice(val id: Long, val text: String, val undo: (() -> Unit)? = null)

/* A transfer in flight or just finished, with its own bar, as the web's panel shows them. */
data class TransferItem(
    val id: String, val kind: String, val name: String, val fraction: Float, val done: Boolean = false, val failed: Boolean = false,
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
)

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
    val error: String? = null,
    val busy: Boolean = false,
    /* Trash rows being restored or deleted, and the whole trash being emptied: each shows it is under way. */
    val trashWorking: Set<String> = emptySet(),
    val emptyingTrash: Boolean = false,
    /* A pull on the trash list, the only thing its refresh ring stands for. */
    val refreshingTrash: Boolean = false,
    /* The last request could not reach the server; what is on the phone is shown. */
    val unreachable: Boolean = false,
    /* Folder ids (and "recents") being fetched right now. */
    val loading: Set<String> = emptySet(),
) {
    /* Every item this session has opened, for search across folders. */
    val everything: List<Opened> get() = (folders.values.flatten() + recents).distinctBy { it.id }
}

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

    private fun signedIn(user: SessionUser) {
        vault = Vault.fromShared(context)
        _state.update { it.copy(gate = Gate.SIGNED_IN, user = user) }
        watchQueue()
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
            kotlinx.coroutines.flow.combine(work.getWorkInfosByTagFlow(com.hushos.app.data.TransferQueue.TAG), hiddenWork) { infos, hidden -> infos to hidden }.collectLatest { (infos, hidden) ->
                lastInfos = infos
                val inUse = infos.mapNotNull { info -> info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:")?.let { File(it).parent } }.toSet()
                viewModelScope.launch(Dispatchers.IO) { com.hushos.app.data.TransferQueue.sweep(context, inUse) }
                val shown = infos.filter { it.state != androidx.work.WorkInfo.State.CANCELLED && it.id !in hidden }
                val items = shown.map { info ->
                    val tag = { prefix: String -> info.tags.firstOrNull { it.startsWith(prefix) }?.removePrefix(prefix) }
                    val file = tag("file:")
                    val finished = info.state.isFinished
                    val failed = info.state == androidx.work.WorkInfo.State.FAILED
                    val kept = failed && info.outputData.getString("file")?.let { File(it).exists() } == true
                    TransferItem(
                        id = info.id.toString(), kind = tag("kind:") ?: "upload", name = tag("name:") ?: "File",
                        fraction = if (info.state == androidx.work.WorkInfo.State.SUCCEEDED) 1f else info.progress.getFloat("fraction", 0f),
                        done = finished, failed = failed,
                        waiting = info.state == androidx.work.WorkInfo.State.ENQUEUED || info.state == androidx.work.WorkInfo.State.BLOCKED,
                        cancel = if (finished) null else ({ com.hushos.app.data.TransferQueue.cancel(context, info.id, file) }),
                        message = if (failed) info.outputData.getString("message") ?: "The transfer failed." else null,
                        dismiss = if (failed) ({ forgetQueued(listOf(info.id)) }) else null,
                        retry = if (kept) ({ retryQueued(info) }) else null,
                    )
                }
                _state.update { it.copy(queued = items) }
                val newlyLanded = infos.filter { it.state == androidx.work.WorkInfo.State.SUCCEEDED && landed.add(it.id) }
                // Its own coroutine: the next queue update must not cancel the refresh halfway.
                if (newlyLanded.isNotEmpty()) viewModelScope.launch { sync(); refreshOffline(); state.value.folders.keys.forEach { refresh(it) } }
                if (infos.isNotEmpty() && infos.all { it.state.isFinished }) {
                    if (shown.isNotEmpty()) kotlinx.coroutines.delay(4000)
                    if (shown.none { it.state == androidx.work.WorkInfo.State.FAILED }) work.pruneWork()
                    else hiddenWork.update { it + infos.filter { info -> info.state == androidx.work.WorkInfo.State.SUCCEEDED }.map { info -> info.id } }
                }
            }
        }
    }

    /* Takes queued rows off the panel; a failed upload's kept copy goes with its row. */
    private fun forgetQueued(ids: Collection<java.util.UUID>) {
        if (ids.isEmpty()) return
        lastInfos.filter { it.id in ids && it.state == androidx.work.WorkInfo.State.FAILED }
            .forEach { com.hushos.app.data.TransferQueue.discard(it.outputData.getString("file")) }
        hiddenWork.update { it + ids }
    }

    /* Queues a failed upload again from its copy; the failed row makes way for the new one. */
    private fun retryQueued(info: androidx.work.WorkInfo) {
        hiddenWork.update { it + info.id }
        if (!com.hushos.app.data.TransferQueue.retryUpload(context, info.outputData)) notify("The file to upload is gone. Pick it again.")
    }

    /* Takes in-app rows off the panel, and the copies failed ones kept. */
    private fun removeTransfers(which: (TransferItem) -> Boolean) {
        val gone = state.value.transfers.filter(which)
        gone.forEach { stagedCopies.remove(it.id)?.delete() }
        _state.update { s -> s.copy(transfers = s.transfers.filterNot(which)) }
    }

    /* A new transfer replaces the failures still on show: the panel is about what is happening now. */
    private fun clearFailures() {
        forgetQueued(state.value.queued.filter { it.failed }.map { java.util.UUID.fromString(it.id) })
        removeTransfers { it.failed }
    }

    /* The panel's close: once nothing is running, every finished row goes, failures included. */
    fun closeTransfers() {
        forgetQueued(state.value.queued.filter { it.done }.map { java.util.UUID.fromString(it.id) })
        removeTransfers { it.done }
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
            result.onSuccess { signedIn(it); done(null) }.onFailure { done(it.message ?: "Please try again.") }
        }
    }

    fun signOut() {
        // Queued transfers belong to the account signing out: stopped, and their copies removed.
        androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(com.hushos.app.data.TransferQueue.TAG)
        File(context.filesDir, "queue").deleteRecursively()
        queueWatch?.cancel(); queueWatch = null
        viewModelScope.launch {
            withContext(Dispatchers.IO) { Auth.signOut(context) }
            vault = null
            _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin)
        }
    }

    private fun sessionLost() {
        Shared.clearSession(context)
        vault = null
        _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin, error = "Your session ended. Sign in again.")
    }

    fun clearError() = _state.update { it.copy(error = null) }

    override fun onCleared() {
        runCatching { connectivity.unregisterNetworkCallback(network) }
        super.onCleared()
    }

    private fun begin(kind: String, name: String): String {
        val id = java.util.UUID.randomUUID().toString()
        _state.update { it.copy(transfers = it.transfers + TransferItem(id, kind, name, 0f)) }
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
            if (failure != null) failure(message) else _state.update { it.copy(error = message) }
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
        val kept = Offline.entries(context).filter { it.id in touched && it.id !in refreshingKept }
        if (kept.isEmpty()) return
        refreshingKept.addAll(kept.map { it.id })
        viewModelScope.launch {
            val ids = kept.map { it.id }
            val vault = vault
            // Only files whose copy is missing get a row: a rename or a tag moves nothing.
            val stale = withContext(Dispatchers.IO) {
                kept.filter { entry -> vault?.item(entry.id)?.let { !Offline.hasVersion(context, it) && it.node.trashedAt == null } ?: true }
            }
            val tickets = stale.associate { it.id to begin("keep", it.name) }
            var reason: String? = null
            val failed = io({ reason = it }) { v -> v.refreshOffline(ids) { id, fraction -> tickets[id]?.let { progress(it, fraction) } } } ?: ids.toSet()
            // Offline, the banner already says why; a row per kept file would only repeat it.
            tickets.forEach { (id, ticket) ->
                if (id in failed && state.value.unreachable) drop(ticket)
                else finish(ticket, failed = id in failed, message = reason ?: "Couldn't update the downloaded copy.")
            }
            refreshingKept.removeAll(ids.toSet())
            refreshOffline()
        }
    }

    private suspend fun redraw(folderIds: Collection<String>) {
        val vault = vault ?: return
        val fresh = withContext(Dispatchers.IO) { folderIds.associateWith { runCatching { vault.listChildren(it) }.getOrNull() } }
        val recents = withContext(Dispatchers.IO) { runCatching { vault.recents() }.getOrNull() }
        _state.update { s -> s.copy(folders = s.folders + fresh.filterValues { it != null }.mapValues { it.value!! }, recents = recents ?: s.recents) }
    }

    fun refresh(folderId: String) = viewModelScope.launch {
        _state.update { it.copy(loading = it.loading + folderId) }
        sync()
        io { it.listChildren(folderId) }?.let { children -> _state.update { it.copy(folders = it.folders + (folderId to children)) } }
        _state.update { it.copy(loading = it.loading - folderId) }
    }

    fun refreshRecents() = viewModelScope.launch {
        _state.update { it.copy(loading = it.loading + "recents") }
        loadRoot().join()
        sync()
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
        io { it.mountShares() }?.let { shares -> _state.update { it.copy(shares = shares) } }
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
            if (failure is NotAuthenticated) sessionLost() else done(failure.message ?: "Please try again.")
        }
    }

    fun updateName(name: String, done: (String?) -> Unit) = account({
        val user = Auth.updateName(context, name)
        _state.update { it.copy(user = user) }
        null
    }, done)

    /* The links the owner made for an item, each with its URL when the secret was kept. */
    suspend fun links(item: Opened): List<Pair<LinkView, String?>>? = io { vault -> vault.links(item).map { it to runCatching { vault.linkUrlOf(it, item) }.getOrNull() } }
    suspend fun createLink(item: Opened, password: String?, expiresAt: java.time.Instant?): Pair<LinkView, String>? = io { it.createLink(item, password, expiresAt) }
    suspend fun revokeLink(link: LinkView, item: Opened): Boolean = io { it.revokeLink(link, item); true } ?: false
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
        clearFailures()
        val ticket = begin("rotate", "Rotating keys for ${item.name}")
        var reason: String? = null
        val ok = io({ reason = it }) { vault -> vault.rotate(item) { count -> progress(ticket, 0f, "Rotating keys · $count sealed") }; true } ?: false
        finish(ticket, failed = !ok, message = reason)
        _state.update { it.copy(folders = emptyMap()) }
        item.node.parentId?.let { refresh(it) }
        return revoked && ok
    }

    /* A master-key rotation ends every session too; the app signs in again and hands back the new phrase. */
    fun rotateKeys(password: String, done: (String?, String?) -> Unit) = viewModelScope.launch {
        val email = state.value.user?.email ?: return@launch
        val origin = state.value.origin
        val result = withContext(Dispatchers.IO) { runCatching { val phrase = Auth.rotateKeys(context, password); phrase to Auth.signIn(context, origin, email, password) } }
        result.onSuccess { (phrase, user) -> signedIn(user); done(phrase, null) }.onFailure { failure ->
            if (failure is NotAuthenticated) sessionLost() else done(null, failure.message ?: "Please try again.")
        }
    }

    /* The server ends every session on a password change, as on the web; the app signs in again with the new one. */
    fun changePassword(current: String, new: String, done: (String?) -> Unit) = viewModelScope.launch {
        val email = state.value.user?.email ?: return@launch
        val origin = state.value.origin
        val result = withContext(Dispatchers.IO) { runCatching { Auth.changePassword(context, current, new); Auth.signIn(context, origin, email, new) } }
        result.onSuccess { signedIn(it); done("Your password was changed.") }.onFailure { failure ->
            if (failure is NotAuthenticated) sessionLost() else done(failure.message ?: "Please try again.")
        }
    }

    fun deleteAccount(password: String, done: (String?) -> Unit) = account({
        Auth.deleteAccount(context, password)
        vault = null
        _state.value = DriveState(gate = Gate.SIGNED_OUT, origin = state.value.origin)
        null
    }, done)

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
        if (!ok && failure == null && state.value.unreachable) notify("You're offline, so that didn't happen. Try again once you're connected.")
        // The catalogue answers listings, so pull the feed first: the write is in it already.
        if (ok) sync()
        if (ok && folder != null) io { it.listChildren(folder) }?.let { children -> _state.update { it.copy(folders = it.folders + (folder to children)) } }
        _state.update { it.copy(busy = false) }
        if (ok) context.contentResolver.notifyChange(android.provider.DocumentsContract.buildRootsUri("${context.packageName}.documents"), null)
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
        clearFailures()
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
        val text = if (items.size == 1) "Moved “${items[0].name}” to trash" else "Moved ${items.size} items to trash"
        notify(text) { viewModelScope.launch { for (item in items) restoreQuietly(item) } }
    }

    fun notify(text: String, undo: (() -> Unit)? = null) {
        val notice = Notice(System.nanoTime(), text, undo)
        _state.update { it.copy(notice = notice) }
        viewModelScope.launch {
            kotlinx.coroutines.delay(6000)
            _state.update { if (it.notice?.id == notice.id) it.copy(notice = null) else it }
        }
    }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    private suspend fun restoreQuietly(item: Opened) {
        if (write(item.node.parentId) { it.restore(TrashItem(item, false)) }) refreshRecents()
    }
    fun moveAll(items: List<Opened>, folder: String) = viewModelScope.launch { for (item in items) move(item, folder).join() }

    fun trash(item: Opened) = viewModelScope.launch {
        if (trashOne(item)) announceTrash(listOf(item))
    }

    private suspend fun trashOne(item: Opened): Boolean {
        val ok = write(item.node.parentId) { it.trash(item.id) }
        _state.update { s -> s.copy(recents = s.recents.filter { it.id != item.id }) }
        return ok
    }
    fun restore(entry: TrashItem) = viewModelScope.launch {
        if (onTrashRow(entry) { it.restore(entry) }) entry.item.node.parentId?.let { if (state.value.folders.containsKey(it)) refresh(it) }
    }
    fun purge(entry: TrashItem) = viewModelScope.launch { onTrashRow(entry) { it.purge(entry.item.id) } }

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
        var failed = 0
        var toTop = 0
        _state.update { it.copy(trashWorking = it.trashWorking + entries.map { e -> e.item.id }) }
        for (entry in ordered) {
            val home = chains[entry.item.id].orEmpty().filter { it.node.trashedAt != null }.all { it.id in back }
            val ok = write(null, { }) { it.restore(entry.copy(parentTrashed = !home)) }
            _state.update { s -> s.copy(trashWorking = s.trashWorking - entry.item.id, trash = if (ok) s.trash.filter { it.item.id != entry.item.id } else s.trash) }
            if (ok) { back.add(entry.item.id); if (!home) toTop++ } else failed++
        }
        sync()
        refreshTrash().join()
        _state.update { it.copy(folders = emptyMap()) }
        val restored = entries.size - failed
        var text = if (failed > 0) "Restored $restored of ${entries.size}; $failed could not be restored" else if (restored == 1) "1 item restored" else "$restored items restored"
        if (toTop > 0) text += if (toTop == 1) ". One went to the top: its folder is still in the trash." else ". $toTop went to the top: their folders are still in the trash."
        notify(text)
    }

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

    /* The server empties a batch at a time, as the web asks it: again until nothing is left or nothing moves. */
    fun emptyTrash() = viewModelScope.launch {
        if (state.value.emptyingTrash) return@launch
        _state.update { it.copy(emptyingTrash = true) }
        var result: com.hushos.app.data.EmptyTrashResult? = null
        do {
            var step: com.hushos.app.data.EmptyTrashResult? = null
            if (!write(null) { step = it.emptyTrash() }) break
            result = step
        } while (result != null && result.remaining > 0 && result.purged > 0)
        if (result?.remaining == 0) _state.update { it.copy(trash = emptyList()) }
        refreshTrash().join()
        _state.update { it.copy(emptyingTrash = false) }
    }
    fun restoreVersion(version: VersionListView, item: Opened) = viewModelScope.launch { write(item.node.parentId) { it.restoreVersion(version, item.id) } }

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
        if (vault != null && items.any { it.isFolder && vault.descends(folder, it.id) }) return "Can't paste a folder into itself"
        return if (items.any { it.node.parentId != folder }) null else "Already here"
    }

    fun upload(uris: List<Uri>, folder: String, onConflict: Conflict = Conflict.KEEP_BOTH, renames: Map<String, String> = emptyMap()) = viewModelScope.launch {
        val existing = (state.value.folders[folder] ?: emptyList()).filter { !it.isFolder }
        val taken = existing.map { it.name.lowercase() }.toSet()
        clearFailures()
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
                viewModelScope.launch { if (file.exists()) uploadNow(file, name, mime, folder, replacing) else notify("The file to upload is gone. Pick it again.") }
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
        if (keep) clearFailures()
        if (keep && item.node.parentId != null && ownDrive(item.node.parentId)) {
            // Queued like an upload: kept once there is a network, whether or not the app is open.
            com.hushos.app.data.TransferQueue.keep(context, item.id, item.name)
        } else if (keep) {
            val ticket = begin("keep", item.name)
            var reason: String? = null
            val ok = io({ reason = it }) { vault -> vault.keepDownloaded(item) { fraction -> progress(ticket, fraction) }; true } ?: false
            finish(ticket, failed = !ok, message = reason)
        } else Offline.forget(context, item.id)
        _state.update { it.copy(offline = Offline.entries(context)) }
    }

    fun refreshOffline() = _state.update { it.copy(offline = Offline.entries(context)) }

    /* The opened item for an id, when this session knows it (the catalogue opens the whole drive). */
    fun item(id: String): Opened? = vault?.item(id)

    fun forgetOffline(id: String) {
        Offline.forget(context, id)
        refreshOffline()
    }

    suspend fun download(item: Opened, version: VersionListView? = null): Uri? {
        if (version == null) Offline.localCopy(context, item)?.let { return FileProvider.getUriForFile(context, "${context.packageName}.shared", it) }
        // Opening a file is not a transfer to announce: the row shows a small ring while it comes down.
        _state.update { it.copy(opening = it.opening + (item.id to 0f)) }
        // Keyed by the version itself, so a file replaced elsewhere is fetched again rather than served from an old copy.
        val file = File(context.cacheDir, "opened/${item.id}/${version?.id ?: item.node.currentVersion?.id ?: "current"}/${item.name}")
        val ok = if (file.exists()) true else io { vault ->
            vault.download(item.id, file, version) { fraction -> _state.update { it.copy(opening = it.opening + (item.id to fraction)) } }
            true
        } ?: false
        _state.update { it.copy(opening = it.opening - item.id) }
        if (!ok && state.value.unreachable) notify("You're offline. Keep a file downloaded to open it without a connection.")
        return if (ok) FileProvider.getUriForFile(context, "${context.packageName}.shared", file) else null
    }
}

/* The emulator talks to the dev server on the host; a real phone talks to production unless the person changes it. */
internal fun defaultOrigin(): String {
    val fingerprint = android.os.Build.FINGERPRINT.lowercase()
    val emulator = fingerprint.contains("generic") || fingerprint.contains("emulator") || android.os.Build.PRODUCT.lowercase().contains("sdk")
    return if (emulator) BuildConfig.DEFAULT_ORIGIN else "https://hushos.com"
}
