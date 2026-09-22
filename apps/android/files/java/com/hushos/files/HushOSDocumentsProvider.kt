package com.hushos.files

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
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.security.keystore.UserNotAuthenticatedException
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException
import java.time.Instant

/*
 * HushOS in Android's Files and every app's file picker. Runs in the app's
 * process without JavaScript: the session and the remembered device come from
 * the encrypted shared store, every key is opened in the Rust core, and
 * content is fetched by chunk and decrypted here (and encrypted on the way up).
 * A missing session becomes an AuthenticationRequiredException, which the
 * system shows as a sign-in affordance that opens the app.
 */
class HushOSDocumentsProvider : DocumentsProvider() {
    private var vault: Vault? = null

    override fun onCreate(): Boolean = true

    private val authority: String get() = "${context!!.packageName}.documents"

    private fun requireVault(): Vault {
        vault?.let { return it }
        val ctx = context ?: throw FileNotFoundException("no context")
        val session = Shared.read(ctx, Shared.SESSION) ?: throw authenticationRequired()
        val created = Vault(ctx, DriveApi(session.getString("origin"), session.getString("token")), session.getString("userId"))
        vault = created
        return created
    }

    private fun authenticationRequired(): Exception {
        val ctx = context!!
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent()
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return android.app.AuthenticationRequiredException(NotAuthenticated(), pending)
    }

    /* Errors the system can show: sign-in for a dead session, otherwise a file-not-found with the message. */
    private fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (e: NotAuthenticated) {
        vault = null
        throw authenticationRequired()
    } catch (e: android.app.AuthenticationRequiredException) {
        throw e
    } catch (e: FileNotFoundException) {
        throw e
    } catch (e: Exception) {
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
            .add(Root.COLUMN_SUMMARY, Shared.read(ctx, Shared.SESSION)?.let { "Encrypted drive" } ?: "Sign in to HushOS")
            .add(Root.COLUMN_DOCUMENT_ID, "root")
        return cursor
    }

    private fun docId(id: String, vault: Vault) = if (id == vault.rootId) "root" else id
    private fun nodeId(documentId: String, vault: Vault) = if (documentId == "root") vault.rootId else documentId

    private fun mimeOf(item: Opened): String {
        if (item.kind == "folder") return Document.MIME_TYPE_DIR
        item.metadata.mime?.let { return it }
        val ext = item.metadata.name.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
    }

    private fun addRow(cursor: MatrixCursor, item: Opened, vault: Vault) {
        val folder = item.kind == "folder"
        var flags = Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE
        if (folder) flags = flags or Document.FLAG_DIR_SUPPORTS_CREATE
        else {
            flags = flags or Document.FLAG_SUPPORTS_WRITE
            if ((item.currentVersion?.optInt("contentSuite") ?: 0) == 2) flags = flags or Document.FLAG_SUPPORTS_THUMBNAIL
        }
        val modified = item.metadata.modified?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
            ?: item.node.optString("updatedAt").takeIf { it.isNotEmpty() }?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        val size = if (folder) null else item.metadata.size ?: item.currentVersion?.optString("plaintextSize")?.toLongOrNull()
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, docId(item.id, vault))
            .add(Document.COLUMN_MIME_TYPE, mimeOf(item))
            .add(Document.COLUMN_DISPLAY_NAME, if (item.id == vault.rootId) "HushOS" else item.metadata.name)
            .add(Document.COLUMN_LAST_MODIFIED, modified)
            .add(Document.COLUMN_FLAGS, flags)
            .add(Document.COLUMN_SIZE, size)
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        val id = nodeId(documentId, vault)
        val item = if (id == vault.rootId) { vault.listChildren(id); vault.item(id)!! } else vault.resolve(id)
        addRow(cursor, item, vault)
        cursor
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor = guarded {
        val vault = requireVault()
        val cursor = MatrixCursor(projection ?: documentColumns)
        for (child in vault.listChildren(nodeId(parentDocumentId, vault))) addRow(cursor, child, vault)
        cursor.setNotificationUri(context!!.contentResolver, android.provider.DocumentsContract.buildChildDocumentsUri(authority, parentDocumentId))
        cursor
    }

    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor = MatrixCursor(projection ?: documentColumns)

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = guarded {
        val vault = requireVault()
        var current: String? = nodeId(documentId, vault)
        val parent = nodeId(parentDocumentId, vault)
        while (current != null) {
            if (current == parent) return@guarded true
            current = runCatching { vault.resolve(current!!).parentId }.getOrNull()
        }
        false
    }

    private fun cacheFile(id: String): File = File(context!!.cacheDir, "files/$id").also { it.parentFile?.mkdirs() }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor = guarded {
        val vault = requireVault()
        val id = nodeId(documentId, vault)
        val item = vault.resolve(id)
        val file = cacheFile(id)
        if (mode.contains("r") && !mode.contains("w")) {
            vault.download(id, file)
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
                    vault.upload(file, fresh.metadata.name, fresh.metadata.mime, fresh.parentId ?: vault.rootId, fresh)
                    context!!.contentResolver.notifyChange(android.provider.DocumentsContract.buildDocumentUri(authority, documentId), null)
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
