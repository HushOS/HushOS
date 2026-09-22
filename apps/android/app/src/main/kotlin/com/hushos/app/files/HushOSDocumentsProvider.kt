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
    private var vault: Vault? = null

    override fun onCreate(): Boolean = true

    private val authority: String get() = "${context!!.packageName}.documents"

    private fun requireVault(): Vault {
        vault?.let { return it }
        val ctx = context ?: throw FileNotFoundException("no context")
        val created = Vault.fromShared(ctx) ?: throw authenticationRequired()
        vault = created
        // The tree on the phone first: listings answer from it, and without a network they still answer.
        runCatching { created.buildCatalogue() }
        return created
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
        vault = null
        throw authenticationRequired()
    } catch (e: AuthenticationRequiredException) {
        throw e
    } catch (e: FileNotFoundException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.w("HushOSFiles", "provider request failed", e)
        throw FileNotFoundException(e.message ?: e.toString())
    }

    private val rootColumns = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_SUMMARY)
    private val documentColumns = arrayOf(
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS, Document.COLUMN_SIZE,
    )

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: rootColumns)
        val ctx = context ?: return cursor
        cursor.newRow()
            .add(Root.COLUMN_ROOT_ID, "hushos")
            .add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD or Root.FLAG_SUPPORTS_RECENTS)
            .add(Root.COLUMN_ICON, ctx.applicationInfo.icon)
            .add(Root.COLUMN_TITLE, "HushOS")
            .add(Root.COLUMN_SUMMARY, Shared.session(ctx)?.let { "Encrypted drive" } ?: "Sign in to HushOS")
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

    private fun addRow(cursor: MatrixCursor, item: Opened, vault: Vault) {
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
        for (child in vault.listChildren(nodeId(parentDocumentId, vault))) addRow(cursor, child, vault)
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
        for (item in vault.recents(64)) addRow(cursor, item, vault)
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
        // Written by another app: the bytes land in the cache file and go up as a new version when it closes.
        if (mode.contains("r")) vault.download(id, file) else file.delete()
        val handler = Handler(Looper.getMainLooper())
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode), handler) { error ->
            if (error != null) return@open
            Thread {
                runCatching {
                    val fresh = vault.resolve(id)
                    vault.upload(file, fresh.name, fresh.metadata.mime, fresh.node.parentId ?: vault.rootId, fresh, vault.makeThumbnail(file, fresh.metadata.mime))
                    context!!.contentResolver.notifyChange(DocumentsContract.buildDocumentUri(authority, documentId), null)
                }
            }.start()
        }
    }

    override fun openDocumentThumbnail(documentId: String, sizeHint: Point, signal: CancellationSignal?): AssetFileDescriptor = guarded {
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val bytes = vault.thumbnail(id) ?: throw FileNotFoundException("no thumbnail")
        val file = File(context!!.cacheDir, "thumbnails/$id").also { it.parentFile?.mkdirs() }
        file.writeBytes(bytes)
        AssetFileDescriptor(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH)
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
}
