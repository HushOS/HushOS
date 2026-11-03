package com.hushos.app.files

import android.app.AuthenticationRequiredException
import android.app.PendingIntent
import android.content.Intent
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
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
    /* The families Files shows for that vault's session (one root each), made and dropped with it under vaultLock. */
    @Volatile private var families: ProviderFamilies? = null
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
            families = null
            // A load begun for the vault dropped here neither lands nor is joined by the next one's requests.
            trustLoad.reset(null) { trust = TrustState.Loading }
            session ?: throw authenticationRequired()
            val created = Vault(ctx, com.hushos.app.data.DriveApi(session))
            // The tree on the phone first: listings answer from it, and without a network they still answer.
            runCatching { created.buildCatalogue() }
            trustLoad.reset(created)
            // Its own area ledger, filled by its own family sync: one per session, never the app's.
            families = ProviderFamilies(created)
            vault = created
            created
        }
    }

    /* The session is gone: the vault goes, and nothing loaded for it lands. */
    private fun dropVault() = synchronized(vaultLock) {
        vault = null
        families = null
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
        // One root per family this vault's own ledger accepted, titled the family's name. No recents: Recent is the
        // personal drive's, as on the web.
        if (Shared.session(ctx) != null) for (family in familyRootsNow()) cursor.newRow()
            .add(Root.COLUMN_ROOT_ID, family.rootId)
            .add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_IS_CHILD or if (family.folders.any { it.writable }) Root.FLAG_SUPPORTS_CREATE else 0)
            .add(Root.COLUMN_ICON, ctx.applicationInfo.icon)
            .add(Root.COLUMN_TITLE, family.name)
            .add(Root.COLUMN_DOCUMENT_ID, family.documentId)
        return cursor
    }

    /* Family loads, off the binder thread, one queued at a time. */
    private val familyLoads = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val familyLoadQueued = java.util.concurrent.atomic.AtomicBoolean()
    /* Tests: runs a family load on the calling thread. */
    internal var runFamilyLoad: ((Runnable) -> Unit)? = null

    /*
     * The family roots as last loaded for the session signed in now; a load is queued when none was made yet, a family
     * appeared or went elsewhere, or the last is old. It tells Files when the roots changed (ProviderFamilies.load).
     */
    private fun familyRootsNow(): List<FamilyRoot> {
        fun held() = liveVault()?.takeIf { !it.closed }?.let { families?.takeIf { f -> f.vault === it } }
        if (held()?.due() != false) loadFamiliesLater()
        return held()?.roots.orEmpty()
    }

    private fun loadFamiliesLater() {
        if (!familyLoadQueued.compareAndSet(false, true)) return
        val load = Runnable {
            try {
                runCatching { requireVault(); families?.load() }
            } finally {
                familyLoadQueued.set(false)
            }
        }
        runFamilyLoad?.invoke(load) ?: familyLoads.execute(load)
    }

    /* The families of the session's vault, made with it. */
    private fun familiesOf(vault: Vault): ProviderFamilies =
        families?.takeIf { it.vault === vault } ?: throw FileNotFoundException(com.hushos.app.data.FamilyWords.OPEN_AGAIN)

    private fun familyCursor(cursor: MatrixCursor, row: FamilyRow) {
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, row.documentId)
            .add(Document.COLUMN_MIME_TYPE, row.mime)
            .add(Document.COLUMN_DISPLAY_NAME, row.name)
            .add(Document.COLUMN_LAST_MODIFIED, row.modified)
            .add(Document.COLUMN_FLAGS, row.flags)
            .add(Document.COLUMN_SIZE, row.size)
            .add(Document.COLUMN_SUMMARY, row.summary)
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
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, docId(item.id, vault))
            .add(Document.COLUMN_MIME_TYPE, mimeOf(item))
            .add(Document.COLUMN_DISPLAY_NAME, if (item.id == vault.rootId) "HushOS" else item.name)
            .add(Document.COLUMN_LAST_MODIFIED, item.modifiedMillis)
            .add(Document.COLUMN_FLAGS, flags)
            .add(Document.COLUMN_SIZE, item.size)
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
        FamilyDoc.of(documentId)?.let { doc ->
            familyCursor(cursor, familiesOf(vault).document(doc))
            return@guarded cursor
        }
        val id = nodeId(documentId, vault)
        val item = if (id == vault.rootId) { vault.listChildren(id); vault.item(id)!! } else vault.resolve(id)
        addRow(cursor, item, vault)
        cursor
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        FamilyDoc.of(parentDocumentId)?.let { doc ->
            for (row in familiesOf(vault).children(doc)) familyCursor(cursor, row)
            // A family folder's writes tell its node id (Vault.foldersChanged); the family's top, its own id.
            val told = if (doc is FamilyDoc.Node) doc.nodeId else doc.id
            cursor.setNotificationUri(context!!.contentResolver, DocumentsContract.buildChildDocumentsUri(authority, told))
            listedAt = android.os.SystemClock.elapsedRealtime()
            FilesPoll.start(context!!)
            return@guarded cursor
        }
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
        // The family roots as well, when due: a family that went disappears from Files while it looks.
        if (families?.takeIf { it.vault === vault }?.due() != false) loadFamiliesLater()
        // The family folders Files shows, listed again (they have no feed here): each that changed is told.
        families?.takeIf { it.vault === vault }?.let { shown -> runCatching { shown.refreshShown(FilesPoll.WINDOW_MS) } }
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
        // A family folder lists from the server each time: false, and Files reloads it itself.
        if (FamilyDoc.of(documentId) != null) return false
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
        val cursor = MatrixCursor(projection ?: documentColumns)
        // Recent is the personal drive's only, as on the web: a family root has none.
        if (rootId != "hushos") return@guarded cursor
        val vault = requireVault()
        val trust = trustFor(vault)
        // Files only: DocumentsUI's Recent drops folders from what a provider returns (its RecentsLoader
        // rejects the directory type), so a folder standing in for what it holds would hide its files.
        for (item in vault.recents(64) { !it.isFolder }.rows) addRow(cursor, item, vault, trust)
        cursor
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = guarded {
        val vault = requireVault()
        val familyParent = FamilyDoc.of(parentDocumentId)
        val familyDoc = FamilyDoc.of(documentId)
        // Never across a family's root and the drive, or two families.
        if (familyParent != null || familyDoc != null) return@guarded familyParent != null && familyDoc != null && familiesOf(vault).isChild(familyParent, familyDoc)
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
        (FamilyDoc.of(documentId) as? FamilyDoc.Node)?.let { return@guarded openFamily(familiesOf(vault), it, mode) }
        if (FamilyDoc.of(documentId) != null) throw FileNotFoundException("Choose a file.")
        val id = nodeId(documentId, vault)
        val item = vault.resolve(id)
        val file = cacheFile(id, item.node.currentVersion?.id)
        if (mode.contains("r") && !mode.contains("w")) {
            // A kept file opens from the phone, network or not; anything else comes down, or resumes, once per version.
            Offline.localCopy(context!!, item)?.let { return@guarded ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }
            if (!file.exists()) vault.download(id, file)
            return@guarded ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        val edit = personalEdit(vault, id, mode)
        val handler = Handler(Looper.getMainLooper())
        ParcelFileDescriptor.open(edit, ParcelFileDescriptor.parseMode(mode), handler) { error ->
            if (error != null) { edit.delete(); return@open }
            Thread { personalWriteBack(vault, id, documentId, edit, item) }.start()
        }
    }

    /*
     * Where another app writes a file of the drive: a file of its own that goes up as a new version when it closes, never
     * the version's read copy (if the upload fails, a later read must not show edits the server never got). It starts
     * from the current version whenever the mode keeps the contents (WriteModes): appending, or reading and writing
     * without truncating. That version is checked with the server first (currentVersion), so an edit never builds on a
     * version that was replaced since, as one a queued write-back landed from its own vault.
     */
    internal fun personalEdit(vault: Vault, id: String, mode: String): File {
        val edit = File(context!!.cacheDir, "edits/$id/${java.util.UUID.randomUUID()}").also { it.parentFile?.mkdirs() }
        if (WriteModes.keepsContents(mode)) {
            val item = currentVersion(vault, id)
            val file = cacheFile(id, item.node.currentVersion?.id)
            if (!file.exists()) vault.download(id, file)
            file.copyTo(edit, overwrite = true)
        }
        return edit
    }

    /*
     * A family file: read from the family folder's copies; written into an edit of its own, queued as a new version when
     * the other app closes it (ProviderFamilies.writeBack: the transfer queue, its ledger and its retries). One the family
     * refuses before it is queued is deleted, as the family's plaintext never outlives the try.
     */
    private fun openFamily(families: ProviderFamilies, doc: FamilyDoc.Node, mode: String): ParcelFileDescriptor {
        if (mode.contains("r") && !mode.contains("w")) {
            // A save of it still pending (waiting, retrying, failed) is what another app last wrote: read that, never the
            // server's older version.
            families.pendingRead(doc)?.let { pending -> return ParcelFileDescriptor.open(pending, ParcelFileDescriptor.MODE_READ_ONLY).also { pending.delete() } }
            return ParcelFileDescriptor.open(families.readCopy(doc), ParcelFileDescriptor.MODE_READ_ONLY)
        }
        val edit = families.editFor(doc, mode)
        val opened = families.node(doc)
        // On the saves' own thread (WriteBacks.closes), in close order, never the main one.
        return ParcelFileDescriptor.open(edit, ParcelFileDescriptor.parseMode(mode), WriteBacks.closes) { error -> onFamilyEditClosed(error, families, doc, edit, opened) }
    }

    /*
     * The other app closed a family file it wrote: it becomes the file's pending save, here in the close callback so saves
     * keep the order they were closed in (ProviderFamilies.save). Nothing is sent from here; the slot's job sends it.
     */
    internal fun onFamilyEditClosed(error: java.io.IOException?, families: ProviderFamilies, doc: FamilyDoc.Node, edit: File, opened: com.hushos.app.data.Opened) {
        try {
            if (error == null && !families.save(doc, edit, opened)) android.util.Log.w("HushOSFiles", "a family save wasn't kept")
        } catch (failure: Exception) {
            android.util.Log.w("HushOSFiles", "a family save couldn't be kept: ${failure.javaClass.name}")
        } finally {
            edit.delete()
        }
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

    /*
     * What another app wrote, once it closed the file: a new version, sent now when it can be. Not sent now (no network,
     * the name it keeps couldn't be checked, or the file's row couldn't be looked up now): the queue takes the edit and
     * tries again, rather than the edit being dropped. `opened` is the file as it was when the app opened it, which the
     * queued job is told of when the lookup fails; the job looks it up again itself.
     */
    internal fun personalWriteBack(vault: Vault, id: String, documentId: String, edit: File, opened: com.hushos.app.data.Opened) {
        val fresh = runCatching { vault.resolve(id) }.getOrNull()
        val sent = fresh != null && runCatching {
            vault.upload(edit, fresh.name, fresh.metadata.mime, fresh.node.parentId ?: vault.rootId, fresh, vault.makeThumbnail(edit, fresh.metadata.mime))
            context!!.contentResolver.notifyChange(DocumentsContract.buildDocumentUri(authority, documentId), null)
        }.isSuccess
        if (!sent) runCatching {
            val known = fresh ?: opened
            com.hushos.app.data.TransferQueue.upload(context!!, edit, known.name, known.metadata.mime, known.node.parentId ?: vault.rootId, known.id)
        }
        edit.delete()
    }

    /* Through a pipe, never a plaintext file in the cache: the decrypted JPEG exists only in memory and in transit. */
    override fun openDocumentThumbnail(documentId: String, sizeHint: Point, signal: CancellationSignal?): AssetFileDescriptor = guarded {
        val vault = requireVault()
        val family = FamilyDoc.of(documentId)
        val bytes = if (family != null) (family as? FamilyDoc.Node)?.let { familiesOf(vault).thumbnail(it) } ?: throw FileNotFoundException("no thumbnail")
            else vault.thumbnail(nodeId(documentId, vault)) ?: throw FileNotFoundException("no thumbnail")
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
        FamilyDoc.of(parentDocumentId)?.let { doc ->
            val node = doc as? FamilyDoc.Node ?: throw FileNotFoundException("Choose a family folder.")
            return@guarded familiesOf(vault).create(node, mimeType, displayName)
        }
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
        FamilyDoc.of(documentId)?.let { doc ->
            familiesOf(vault).rename(doc as? FamilyDoc.Node ?: throw FileNotFoundException(com.hushos.app.data.FamilyWords.UNAVAILABLE), com.hushos.app.data.wellFormed(displayName))
            return@guarded null
        }
        vault.rename(nodeId(documentId, vault), displayName)
        null
    }

    override fun moveDocument(sourceDocumentId: String, sourceParentDocumentId: String, targetParentDocumentId: String): String? = guarded {
        val vault = requireVault()
        val source = FamilyDoc.of(sourceDocumentId)
        val target = FamilyDoc.of(targetParentDocumentId)
        if (source != null || target != null) {
            // Within one family folder only: never into or out of the drive, another folder or another family.
            if (source !is FamilyDoc.Node || target !is FamilyDoc.Node) throw FileNotFoundException(com.hushos.app.data.FamilyWords.UNAVAILABLE)
            familiesOf(vault).move(source, target)
            return@guarded null
        }
        vault.move(nodeId(sourceDocumentId, vault), nodeId(targetParentDocumentId, vault))
        null
    }

    override fun deleteDocument(documentId: String) = guarded {
        val vault = requireVault()
        FamilyDoc.of(documentId)?.let { doc ->
            familiesOf(vault).delete(doc as? FamilyDoc.Node ?: throw FileNotFoundException(com.hushos.app.data.FamilyWords.UNAVAILABLE))
            return@guarded
        }
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
