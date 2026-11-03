package com.hushos.app.files

import android.app.AuthenticationRequiredException
import android.app.PendingIntent
import android.content.Intent
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import com.hushos.app.data.FilesRoots
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.WriteBacks
import com.hushos.app.data.sync
import com.hushos.app.data.buildCatalogue
import com.hushos.app.data.Offline
import com.hushos.app.data.SharedLoad
import com.hushos.app.data.TrustState
import com.hushos.app.data.providerSummary
import java.io.File
import java.io.FileNotFoundException

/*
 * How a mode another app opens a file in treats what the file holds (ParcelFileDescriptor.parseMode): "w", "wt" and
 * "rwt" truncate, so the write starts empty; "wa" appends and "rw" writes over it in place, so both start from the
 * current version, or the new version would lose everything the other app didn't write again.
 */
object WriteModes {
    fun keepsContents(mode: String): Boolean = mode.contains('a') || (mode.contains('r') && !mode.contains('t'))
}

/*
 * HushOS in Android's Files and every app's file picker. Runs in the app's
 * process: the session and the remembered device come from the encrypted
 * shared store, every key is opened in the Rust core, and content is fetched
 * by chunk and decrypted here (and encrypted on the way up). A missing
 * session becomes an AuthenticationRequiredException, which the system shows
 * as a sign-in affordance that opens the app.
 */
class HushOSDocumentsProvider : DocumentsProvider() {
    /* Read on any thread; replaced only under vaultLock, one Vault per session. */
    @Volatile private var vault: Vault? = null
    private val vaultLock = Any()

    override fun onCreate(): Boolean {
        current = this
        return true
    }

    private val authority: String get() = "${context!!.packageName}.documents"

    /*
     * The vault for the session signed in now. A sign-out, another account signing in, or a
     * new session after a password change or a key reset drops the one held here, so the
     * Files app never answers from an account (or a token) that is gone.
     */
    private fun requireVault(): Vault {
        val ctx = context ?: throw FileNotFoundException("no context")
        val session = Shared.session(ctx)
        // One whose session ended (the app's vault closed it: a sign-out, another sign-in) is replaced, never answered from.
        vault?.let { if (session != null && it.api.session == session && !it.closed) return it }
        return synchronized(vaultLock) {
            // Another request may have replaced it while this one waited: then it is that one.
            vault?.let { if (session != null && it.api.session == session && !it.closed) return it }
            vault = null
            // A load begun for the vault dropped here neither lands nor is joined by the next one's requests.
            trustLoad.reset(null) { trust = TrustState.Loading }
            session ?: throw authenticationRequired()
            val created = Vault(ctx, com.hushos.app.data.DriveApi(session))
            // The tree on the phone first: listings answer from it, and without a network they still answer.
            runCatching { created.buildCatalogue() }
            trustLoad.reset(created)
            vault = created
            created
        }
    }

    /* The session is gone: the vault goes, and nothing loaded for it lands. */
    private fun dropVault() = synchronized(vaultLock) {
        vault = null
        trustLoad.reset(null) { trust = TrustState.Loading }
    }

    /*
     * The picker starts this for a result, in its own task, so no FLAG_ACTIVITY_NEW_TASK (a new task answers
     * RESULT_CANCELED at once). PickerSignInActivity finishes with RESULT_OK once the account is open, and the
     * picker comes back to the foreground and lists the drive. The app's launcher entry is untouched.
     */
    private fun authenticationRequired(): Exception {
        val ctx = context!!
        val signIn = Intent(ctx, com.hushos.app.PickerSignInActivity::class.java)
        val pending = PendingIntent.getActivity(ctx, 0, signIn, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return AuthenticationRequiredException(NotAuthenticated(), pending)
    }

    /* Errors the system can show: sign-in for a dead session, otherwise a file-not-found with the message. */
    private fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (e: NotAuthenticated) {
        dropVault()
        throw authenticationRequired()
    } catch (e: AuthenticationRequiredException) {
        throw e
    } catch (e: FileNotFoundException) {
        throw e
    } catch (e: Exception) {
        // The message can carry a decrypted name or path: only the exception's type goes to the log.
        android.util.Log.w("HushOSFiles", "provider request failed: ${e.javaClass.name}")
        throw FileNotFoundException(e.message ?: e.toString())
    }

    /* Whom this account trusts, for the rows' Unverified label, and when it was last asked. */
    @Volatile private var trust: TrustState = TrustState.Loading
    @Volatile private var trustAt = 0L
    private val trustLoad = SharedLoad<Vault, Result<com.hushos.app.data.Trust>>()

    /*
     * The trust set, loaded at most every few minutes (a failed load is asked again sooner), as the app's own lists
     * use it. A load that fails marks every row, never none (docs/integrity-design.md, "Checking fails closed").
     * Requests arrive on many threads: they share one load (SharedLoad), which is kept only while its vault is still
     * this provider's (`reset` in requireVault); one for a vault dropped since answers its own request and keeps nothing.
     */
    private fun trustFor(vault: Vault): TrustState {
        val now = android.os.SystemClock.elapsedRealtime()
        val current = trust
        val fresh = if (current is TrustState.Ready) TRUST_TTL_MS else TRUST_RETRY_MS
        if (current !is TrustState.Loading && now - trustAt < fresh) return current
        val result = trustLoad.load(vault, { runCatching { vault.trust() } }) { read ->
            if (read.exceptionOrNull() !is NotAuthenticated) {
                trust = trust.after(read)
                trustAt = now
            }
        }
        if (result.exceptionOrNull() is NotAuthenticated) throw result.exceptionOrNull()!!
        return current.after(result)
    }

    private fun summaryOf(item: Opened, trust: TrustState): String? = providerSummary(item.node, trust)

    private val rootColumns = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_SUMMARY)
    private val documentColumns = arrayOf(
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_SUMMARY,
    )

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: rootColumns)
        val ctx = context ?: return cursor
        cursor.newRow()
            .add(Root.COLUMN_ROOT_ID, "hushos")
            .add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD or Root.FLAG_SUPPORTS_RECENTS)
            .add(Root.COLUMN_ICON, ctx.applicationInfo.icon)
            .add(Root.COLUMN_TITLE, "HushOS")
            // The account it opens, as the board has it; signed out, the way in.
            .add(Root.COLUMN_SUMMARY, Shared.session(ctx)?.let { it.email.ifEmpty { null } } ?: if (Shared.session(ctx) == null) "Sign in to HushOS" else null)
            .add(Root.COLUMN_DOCUMENT_ID, "root")
        return cursor
    }

    private fun docId(id: String, vault: Vault) = FilesRoots.documentId(id, vault.rootId)
    private fun nodeId(documentId: String, vault: Vault) = FilesRoots.nodeId(documentId, vault.rootId)

    private fun mimeOf(item: Opened): String {
        if (item.isFolder) return Document.MIME_TYPE_DIR
        item.metadata.mime?.let { return it }
        val ext = item.name.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
    }

    private fun addRow(cursor: MatrixCursor, item: Opened, vault: Vault, trust: TrustState = trustFor(vault)) {
        var flags = Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE
        if (item.isFolder) flags = flags or Document.FLAG_DIR_SUPPORTS_CREATE
        else {
            flags = flags or Document.FLAG_SUPPORTS_WRITE
            if (item.hasThumbnail) flags = flags or Document.FLAG_SUPPORTS_THUMBNAIL
        }
        // A file with a pending save shows that save's size and date: the bytes a read returns.
        val pending = if (item.isFolder) null else WriteBacks.pendingMeta(context!!, WriteBacks.slotOf(item.node.workspaceId, item.id))
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, docId(item.id, vault))
            .add(Document.COLUMN_MIME_TYPE, mimeOf(item))
            .add(Document.COLUMN_DISPLAY_NAME, if (item.id == vault.rootId) "HushOS" else item.name)
            .add(Document.COLUMN_LAST_MODIFIED, pending?.second ?: item.modifiedMillis)
            .add(Document.COLUMN_FLAGS, flags)
            .add(Document.COLUMN_SIZE, pending?.first ?: item.size)
            // The same verdict the app's rows show, so a planted file is not passed off as clean in a picker.
            .add(Document.COLUMN_SUMMARY, if (item.id == vault.rootId) null else summaryOf(item, trust))
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor = guarded {
        val cursor = MatrixCursor(projection ?: documentColumns)
        // Signed out, the root still answers as an empty folder; listing it is what asks for sign-in.
        if (documentId == "root" && Shared.session(context!!) == null) {
            cursor.newRow().add(Document.COLUMN_DOCUMENT_ID, "root").add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
                .add(Document.COLUMN_DISPLAY_NAME, "HushOS").add(Document.COLUMN_FLAGS, 0)
            return@guarded cursor
        }
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val item = if (id == vault.rootId) { vault.listChildren(id); vault.item(id)!! } else vault.resolve(id)
        addRow(cursor, item, vault)
        cursor
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        val trust = trustFor(vault)
        for (child in vault.listChildren(nodeId(parentDocumentId, vault))) addRow(cursor, child, vault, trust)
        cursor.setNotificationUri(context!!.contentResolver, DocumentsContract.buildChildDocumentsUri(authority, parentDocumentId))
        listedAt = android.os.SystemClock.elapsedRealtime()
        pulls.request(parentDocumentId)
        FilesPoll.start(context!!)
        cursor
    }

    private val background = java.util.concurrent.Executors.newSingleThreadExecutor()

    /*
     * The listing answers from what the phone holds; the feed is pulled after, off the binder thread, and the sync
     * tells Files of every folder it changed (Vault.sync). A slow or absent network never holds a listing up.
     */
    private val pulls = FeedPulls(
        execute = { background.execute(it) },
        pull = { liveVault()?.sync() },
        tell = { folders ->
            val ctx = context ?: return@FeedPulls
            for (folder in folders) ctx.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, folder), null)
        },
    )

    /* When Files or a picker last asked for a listing: polls run until FilesPoll.WINDOW_MS after it. */
    @Volatile private var listedAt = 0L

    /*
     * One poll of the feed, on the calling job's thread, which keeps this process thawed until it returns (the sync tells
     * Files of what changed). False once no listing was asked for within the window: the polls stop.
     */
    internal fun pollOnce(): Boolean {
        if (listedAt == 0L || android.os.SystemClock.elapsedRealtime() - listedAt >= FilesPoll.WINDOW_MS) return false
        val vault = liveVault() ?: return false
        runCatching { vault.sync() }
        return true
    }

    /*
     * Files' pull-down (DocumentsUI's swipe calls this with the folder's document URI): a sync now, then the folder told
     * to ask again (ProviderRefresh), with the binder waiting at most REFRESH_WAIT_MS. False when signed out or no vault
     * is open yet, and when the sync didn't reach the server in time: Files then reloads the folder itself.
     */
    override fun refresh(uri: android.net.Uri, extras: android.os.Bundle?, cancellationSignal: CancellationSignal?): Boolean = runCatching {
        val ctx = context ?: return false
        val documentId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return false
        val vault = liveVault() ?: return false
        val rootId = vault.rootId
        val folder = FilesRoots.nodeId(documentId, rootId)
        // Someone is looking: the polls run on from now.
        listedAt = android.os.SystemClock.elapsedRealtime()
        FilesPoll.start(ctx)
        ProviderRefresh.run(
            submit = { background.submit(it) },
            sync = { vault.sync() != null },
            tell = { FilesRoots.foldersChanged(ctx, listOf(folder), rootId) },
            waitMs = REFRESH_WAIT_MS,
            cancelled = { cancellationSignal?.isCanceled == true },
        )
    }.getOrDefault(false)

    /* The vault while its session is still the one signed in: nothing is pulled for an account that has left. */
    private fun liveVault(): Vault? {
        val held = vault ?: return null
        val ctx = context ?: return null
        return held.takeIf { Shared.session(ctx) == it.api.session }
    }

    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        val trust = trustFor(vault)
        // Files only: DocumentsUI's Recent drops folders from what a provider returns (its RecentsLoader
        // rejects the directory type), so a folder standing in for what it holds would hide its files.
        for (item in vault.recents(64) { !it.isFolder }.rows) addRow(cursor, item, vault, trust)
        cursor
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = guarded {
        val vault = requireVault()
        isUnder(vault, nodeId(parentDocumentId, vault), nodeId(documentId, vault))
    }

    /*
     * Whether `id` sits under `parent` now, as the server says, before a tree grant is honoured: this account's own drive
     * brought to the feed's head first (Vault.sync), so a node another device moved out of the tree since is where it is
     * now, never where the cache last saw it. The provider lists only this account's own drive, so a node of any other
     * workspace is outside every tree, as is anything that can't be confirmed (no answer, a node the drive doesn't hold).
     */
    private fun isUnder(vault: Vault, parent: String, id: String): Boolean {
        val own = vault.ownWorkspaceId
        var synced = false
        var current: String? = id
        repeat(MAX_TREE_DEPTH) {
            val at = current ?: return false
            if (at == parent) return true
            current = try {
                val held = vault.resolve(at)
                val ws = held.node.workspaceId
                if (ws.equals(own, ignoreCase = true)) {
                    if (!synced) {
                        if (vault.sync() == null) return false
                        synced = true
                    }
                    vault.resolve(at).node.parentId
                } else return false
            } catch (error: NotAuthenticated) {
                throw error
            } catch (_: Exception) {
                return false
            }
        }
        return false
    }

    /* Per version, so a download resumed after a replacement never mixes two versions' bytes. */
    private fun cacheFile(id: String, versionId: String?): File = File(context!!.cacheDir, "files/$id/${versionId ?: "new"}").also { it.parentFile?.mkdirs() }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor = guarded {
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val item = vault.resolve(id)
        val slot = WriteBacks.slotOf(item.node.workspaceId, id)
        if (mode.contains("r") && !mode.contains("w")) {
            // A save of it still pending (waiting, retrying, failed) is what another app last wrote: read that, never the
            // server's older version, which an app that reads then truncates would write the save away with.
            val pending = File(context!!.cacheDir, "files/$id/pending-${java.util.UUID.randomUUID()}")
            if (WriteBacks.copyTo(context!!, slot, pending)) return@guarded ParcelFileDescriptor.open(pending, ParcelFileDescriptor.MODE_READ_ONLY).also { pending.delete() }
            // A save of it landed from its job's own vault since: this vault may still hold the version before, so the
            // version is checked with the server first (without an answer, the row held is read).
            val seen = WriteBacks.landedSince(slot)
            val item = if (seen == null) item else runCatching { currentVersion(vault, id) }.getOrNull()?.also { WriteBacks.caughtUp(slot, seen) } ?: item
            val file = cacheFile(id, item.node.currentVersion?.id)
            // A kept file opens from the phone, network or not; anything else comes down, or resumes, once per version.
            Offline.localCopy(context!!, item)?.let { return@guarded ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }
            if (!file.exists()) vault.download(id, file)
            return@guarded ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        val edit = personalEdit(vault, id, mode)
        ParcelFileDescriptor.open(edit, ParcelFileDescriptor.parseMode(mode), WriteBacks.closes) { error -> onEditClosed(error, vault, edit, item) }
    }

    /*
     * The other app closed what it wrote: it becomes the file's pending save (WriteBacks.save, in the close callback
     * itself, so saves land in the order the app closed them), and the file's job is queued to send it. Nothing is sent
     * from here: the job sends the newest save, and the provider never uploads past it. A save the account's sign-out
     * overtook keeps nothing.
     */
    internal fun onEditClosed(error: java.io.IOException?, vault: Vault, edit: File, opened: com.hushos.app.data.Opened) {
        if (error != null) { edit.delete(); return }
        try {
            val target = WriteBacks.Target(opened.node.workspaceId, opened.id, opened.name, opened.metadata.mime, opened.node.parentId ?: vault.rootId)
            if (WriteBacks.save(context!!, vault.ledgerGeneration, target, edit) != null)
                com.hushos.app.data.TransferQueue.enqueueSlot(context!!, WriteBacks.slotOf(target.workspaceId, target.nodeId), opened.name)
        } catch (failure: Exception) {
            android.util.Log.w("HushOSFiles", "a save couldn't be kept: ${failure.javaClass.name}")
        } finally {
            edit.delete()
        }
    }

    /*
     * Where another app writes a file of the drive: a file of its own that becomes the file's pending save when it
     * closes, never the version's read copy. It starts from the current contents whenever the mode keeps them (WriteModes):
     * appending, or reading and writing without truncating. Those are the file's pending save when it has one (what the
     * app last wrote, not landed yet); else the server's version, checked first (currentVersion), so an edit never builds
     * on a version replaced since.
     */
    internal fun personalEdit(vault: Vault, id: String, mode: String): File {
        val edit = File(context!!.cacheDir, "edits/$id/${java.util.UUID.randomUUID()}").also { it.parentFile?.mkdirs() }
        if (WriteModes.keepsContents(mode)) {
            if (WriteBacks.copyTo(context!!, WriteBacks.slotOf(vault.resolve(id).node.workspaceId, id), edit)) return edit
            val item = currentVersion(vault, id)
            val file = cacheFile(id, item.node.currentVersion?.id)
            if (!file.exists()) vault.download(id, file)
            file.copyTo(edit, overwrite = true)
        }
        return edit
    }

    /*
     * The file as the server holds it now: this account's own drive brought up to the feed's head (Vault.sync), a share's
     * folder listed again. A version that landed elsewhere (another device, a transfer job's vault) replaces the row held
     * here. No answer is refused: an edit built on a version that can't be checked could replace a newer one.
     */
    private fun currentVersion(vault: Vault, id: String): com.hushos.app.data.Opened {
        val held = vault.resolve(id)
        val ws = held.node.workspaceId
        if (ws.equals(vault.ownWorkspaceId, ignoreCase = true)) {
            if (vault.sync() == null) throw FileNotFoundException(com.hushos.app.data.GroupsApiError.NO_ANSWER)
        } else held.node.parentId?.let { vault.listChildren(it, ws) }
        return vault.resolve(id)
    }

    /* Through a pipe, never a plaintext file in the cache: the decrypted JPEG exists only in memory and in transit. */
    override fun openDocumentThumbnail(documentId: String, sizeHint: Point, signal: CancellationSignal?): AssetFileDescriptor = guarded {
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val bytes = vault.thumbnail(id) ?: throw FileNotFoundException("no thumbnail")
        val (read, write) = ParcelFileDescriptor.createReliablePipe()
        // At most 64 KiB, about a pipe's buffer: written on its own thread so a slow reader never holds the binder thread.
        Thread {
            ParcelFileDescriptor.AutoCloseOutputStream(write).use { out -> runCatching { out.write(bytes) }.onFailure { write.closeWithError(it.javaClass.name) } }
        }.start()
        AssetFileDescriptor(read, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, given: String): String = guarded {
        // Another app's name for what it saves: made well formed, so a lone surrogate never reaches the core.
        val displayName = com.hushos.app.data.wellFormed(given)
        val vault = requireVault()
        val parent = nodeId(parentDocumentId, vault)
        if (mimeType == Document.MIME_TYPE_DIR) return@guarded vault.createFolder(parent, displayName).id
        // An empty file first; the bytes follow through openDocument in write mode.
        val empty = File.createTempFile("new", null, context!!.cacheDir)
        try {
            vault.upload(empty, displayName, mimeType.takeIf { it != "application/octet-stream" }, parent, null).id
        } finally {
            empty.delete()
        }
    }

    override fun renameDocument(documentId: String, displayName: String): String? = guarded {
        val vault = requireVault()
        vault.rename(nodeId(documentId, vault), displayName)
        null
    }

    override fun moveDocument(sourceDocumentId: String, sourceParentDocumentId: String, targetParentDocumentId: String): String? = guarded {
        val vault = requireVault()
        vault.move(nodeId(sourceDocumentId, vault), nodeId(targetParentDocumentId, vault))
        null
    }

    override fun deleteDocument(documentId: String) = guarded {
        val vault = requireVault()
        vault.trash(nodeId(documentId, vault))
    }

    override fun removeDocument(documentId: String, parentDocumentId: String) = deleteDocument(documentId)

    companion object {
        /* The provider's one instance in this process (the system makes it as the process starts), for FilesPoll's jobs. */
        @Volatile internal var current: HushOSDocumentsProvider? = null

        private const val TRUST_TTL_MS = 5 * 60_000L
        private const val TRUST_RETRY_MS = 30_000L
        private const val REFRESH_WAIT_MS = 5_000L
        private const val MAX_TREE_DEPTH = 256
    }
}
