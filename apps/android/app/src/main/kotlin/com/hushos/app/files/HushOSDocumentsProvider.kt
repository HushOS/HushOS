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
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.sync
import com.hushos.app.data.buildCatalogue
import com.hushos.app.data.Offline
import com.hushos.app.data.SharedLoad
import com.hushos.app.data.TrustState
import com.hushos.app.data.providerSummary
import java.io.File
import java.io.FileNotFoundException

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

    override fun onCreate(): Boolean = true

    private val authority: String get() = "${context!!.packageName}.documents"

    /*
     * The vault for the session signed in now. A sign-out, another account signing in, or a
     * new session after a password change or a key reset drops the one held here, so the
     * Files app never answers from an account (or a token) that is gone.
     */
    private fun requireVault(): Vault {
        val ctx = context ?: throw FileNotFoundException("no context")
        val session = Shared.session(ctx)
        vault?.let { if (session != null && it.api.session == session) return it }
        return synchronized(vaultLock) {
            // Another request may have replaced it while this one waited: then it is that one.
            vault?.let { if (session != null && it.api.session == session) return it }
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

    private fun authenticationRequired(): Exception {
        val ctx = context!!
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent()
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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

    private fun docId(id: String, vault: Vault) = if (id == vault.rootId) "root" else id
    private fun nodeId(documentId: String, vault: Vault) = if (documentId == "root") vault.rootId else documentId

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
        syncInBackground(vault, parentDocumentId)
        cursor
    }

    private val syncing = java.util.concurrent.atomic.AtomicBoolean(false)
    private val background = java.util.concurrent.Executors.newSingleThreadExecutor()

    /*
     * The listing answers from what the phone holds; the feed is pulled after,
     * off the binder thread, and Files is told to ask again if anything changed.
     * A slow or absent network never holds a listing up.
     */
    private fun syncInBackground(vault: Vault, parentDocumentId: String) {
        if (!syncing.compareAndSet(false, true)) return
        background.execute {
            try {
                val touched = runCatching { vault.sync() }.getOrNull()
                if (!touched.isNullOrEmpty()) context?.contentResolver?.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, parentDocumentId), null)
            } finally {
                syncing.set(false)
            }
        }
    }

    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        val trust = trustFor(vault)
        for (item in vault.recents(64)) addRow(cursor, item, vault, trust)
        cursor
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = guarded {
        val vault = requireVault()
        var current: String? = nodeId(documentId, vault)
        val parent = nodeId(parentDocumentId, vault)
        while (current != null) {
            if (current == parent) return@guarded true
            current = runCatching { vault.resolve(current!!).node.parentId }.getOrNull()
        }
        false
    }

    /* Per version, so a download resumed after a replacement never mixes two versions' bytes. */
    private fun cacheFile(id: String, versionId: String?): File = File(context!!.cacheDir, "files/$id/${versionId ?: "new"}").also { it.parentFile?.mkdirs() }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor = guarded {
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val item = vault.resolve(id)
        val file = cacheFile(id, item.node.currentVersion?.id)
        if (mode.contains("r") && !mode.contains("w")) {
            // A kept file opens from the phone, network or not; anything else comes down, or resumes, once per version.
            Offline.localCopy(context!!, item)?.let { return@guarded ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }
            if (!file.exists()) vault.download(id, file)
            return@guarded ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        // Written by another app: the bytes land in a file of their own and go up as a new version when it closes.
        // Never the version's read copy: if the upload fails, a later read must not show edits the server never got.
        val edit = File(context!!.cacheDir, "edits/$id/${java.util.UUID.randomUUID()}").also { it.parentFile?.mkdirs() }
        if (mode.contains("r")) {
            if (!file.exists()) vault.download(id, file)
            file.copyTo(edit, overwrite = true)
        }
        val handler = Handler(Looper.getMainLooper())
        ParcelFileDescriptor.open(edit, ParcelFileDescriptor.parseMode(mode), handler) { error ->
            if (error != null) { edit.delete(); return@open }
            Thread {
                val fresh = runCatching { vault.resolve(id) }.getOrNull()
                val sent = fresh != null && runCatching {
                    vault.upload(edit, fresh.name, fresh.metadata.mime, fresh.node.parentId ?: vault.rootId, fresh, vault.makeThumbnail(edit, fresh.metadata.mime))
                    context!!.contentResolver.notifyChange(DocumentsContract.buildDocumentUri(authority, documentId), null)
                }.isSuccess
                // Not sent now (no network, or the name it keeps couldn't be checked): the queue takes the edit and tries
                // again, rather than the edit being dropped.
                if (!sent && fresh != null) runCatching {
                    com.hushos.app.data.TransferQueue.upload(context!!, edit, fresh.name, fresh.metadata.mime, fresh.node.parentId ?: vault.rootId, fresh.id)
                }
                edit.delete()
            }.start()
        }
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

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String = guarded {
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

    private companion object {
        const val TRUST_TTL_MS = 5 * 60_000L
        const val TRUST_RETRY_MS = 30_000L
    }
}
