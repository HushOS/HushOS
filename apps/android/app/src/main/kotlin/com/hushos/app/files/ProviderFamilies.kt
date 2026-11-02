package com.hushos.app.files

import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.webkit.MimeTypeMap
import com.hushos.app.data.AreaWrite
import com.hushos.app.data.FamilyCopies
import com.hushos.app.data.FamilyRecords
import com.hushos.app.data.FamilyRootsSignal
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilySync
import com.hushos.app.data.FamilyView
import com.hushos.app.data.FamilyWords
import com.hushos.app.data.FilesRoots
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.SessionEnded
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.requireGuardKept
import com.hushos.app.data.Vault
import com.hushos.app.data.familyWordsSince
import com.hushos.app.data.familyEpoch
import java.io.File
import java.io.FileNotFoundException

/*
 * Families in Android's Files and the pickers (docs/groups-mobile-plan.md, Android 6; iOS 6's one location per family):
 * one root per family, `family:<groupId>`, titled the family's name, holding the family's folders. The provider fills
 * its own area ledger, in its own vault (one per session, made under its vaultLock), with a sync that never sweeps the
 * app's copies and never tells itself (FamilySync's `sweeps` and `tellsFiles`). A root is a family that sync accepted;
 * its folders are the ones route 25 proved and the ledger opened (FamilyArea.openable), never what a member list
 * claims. Rows are only the ledger's own (Vault.item), plaintext copies go under the family folder's copies folder
 * (opened/family/<workspace>) and edits under its edits folder (edits/family/<workspace>), both deleted whole by every
 * forget of the folder, and every write goes through the vault's family write path (familyTarget at its entry, the
 * final gate before each send, the reply gate after).
 */

/* A document id in a family's root: the family's top (its folders), or a node of one of its folders, by workspace. */
sealed interface FamilyDoc {
    val groupId: String

    data class Top(override val groupId: String) : FamilyDoc
    data class Node(override val groupId: String, val workspaceId: String, val nodeId: String) : FamilyDoc

    val id: String get() = when (this) {
        is Top -> PREFIX + groupId
        is Node -> "$PREFIX$groupId:$workspaceId:$nodeId"
    }

    companion object {
        const val PREFIX = "family:"

        /* Only ids that are ids: a document id never names a path, and the personal drive's ids never take this form. */
        fun of(documentId: String): FamilyDoc? {
            if (!documentId.startsWith(PREFIX)) return null
            val parts = documentId.removePrefix(PREFIX).split(':')
            if (parts.any { !FamilyRecords.valid(it.lowercase()) }) return null
            return when (parts.size) {
                1 -> Top(parts[0])
                3 -> Node(parts[0], parts[1], parts[2])
                else -> null
            }
        }
    }
}

/* A family's root as Files shows it: its folders the ones route 25 proved and this vault's ledger opened. */
data class FamilyRoot(
    val groupId: String, val name: String, val folders: List<Folder>,
    /* Kept from an earlier load because the last sync got no answer: readable, written to only once accepted again. */
    val unanswered: Boolean = false,
) {
    data class Folder(val workspaceId: String, val rootId: String, val name: String, val writable: Boolean)

    val documentId: String get() = FamilyDoc.Top(groupId).id
    val rootId: String get() = FamilyDoc.PREFIX + groupId

    fun folder(workspaceId: String): Folder? = folders.firstOrNull { it.workspaceId.equals(workspaceId, ignoreCase = true) }

    /* The same root, read only until the family is accepted again. */
    fun readOnly(): FamilyRoot = copy(folders = folders.map { it.copy(writable = false) }, unanswered = true)

    companion object {
        /* An accepted family's root: only folders that opened through the ledger, writable as the app has them. */
        fun of(groupId: String, name: String, view: FamilyView): FamilyRoot = FamilyRoot(groupId, name, view.areas.mapNotNull { area ->
            val root = area.root?.takeIf { area.openable } ?: return@mapNotNull null
            Folder(area.workspaceId, root.id, area.name!!, area.write == AreaWrite.WRITABLE)
        })
    }
}

/* One row of a family listing or document, in the provider's columns. */
data class FamilyRow(val documentId: String, val mime: String, val name: String, val modified: Long?, val flags: Int, val size: Long?, val summary: String?)

class ProviderFamilies internal constructor(
    val vault: Vault,
    internal val sync: FamilySync,
    private val clock: () -> Long,
) {
    constructor(vault: Vault) : this(vault, FamilySync(vault, sweeps = false, tellsFiles = false), { android.os.SystemClock.elapsedRealtime() })

    private class Snapshot(val roots: List<FamilyRoot>, val at: Long, val signal: Long, val failed: Boolean)

    @Volatile private var snapshot: Snapshot? = null
    private val loadLock = Any()

    /* The roots as last loaded: none before the first load. */
    val roots: List<FamilyRoot> get() = snapshot?.roots.orEmpty()

    /* Never loaded, a family appeared or went elsewhere since (FamilyRootsSignal), or the last load is old. */
    fun due(): Boolean {
        val held = snapshot ?: return true
        if (held.signal != FamilyRootsSignal.now()) return true
        return clock() - held.at >= if (held.failed) RETRY_MS else TTL_MS
    }

    /*
     * One load at a time, joined by whoever asks while it runs: route 2 with every family it stopped listing asked about
     * (a removal wipes it in this vault's ledger, its copies with it), then each active family synced. A family accepted
     * is a root; one whose sync got no answer keeps the root it had (its ledger kept it, as the app keeps it read only);
     * anything else (a removal, a fork, an unchecked or refused chain, a family still waiting to be let in) has none.
     * A list that didn't answer keeps every root as it was. Files is told of the roots and of each family whose folders
     * changed.
     */
    fun load(): List<FamilyRoot> = synchronized(loadLock) { loadHeld() }

    private fun loadHeld(): List<FamilyRoot> {
        snapshot?.let { if (!due()) return it.roots }
        if (vault.closed) throw SessionEnded()
        val signal = FamilyRootsSignal.now()
        val before = snapshot?.roots
        val kept = before.orEmpty().associateBy { it.groupId.lowercase() }
        val listed = try {
            sync.listReconciling().first
        } catch (error: NotAuthenticated) {
            throw error
        } catch (_: Exception) {
            snapshot = Snapshot(before.orEmpty(), clock(), signal, failed = true)
            return before.orEmpty()
        }
        var failed = false
        val next = listed.filter { it.state == "active" }.mapNotNull { summary ->
            when (val state = sync.sync(summary)) {
                is FamilyState.Accepted -> FamilyRoot.of(summary.id, summary.name, state.view)
                // No answer: the root it had stays readable (its ledger kept the family), but nothing is written into it
                // until a sync accepts the family again.
                is FamilyState.Failed -> if (state.words == FamilyWords.NO_ANSWER) { failed = true; kept[summary.id.lowercase()]?.readOnly() } else null
                else -> null
            }
        }
        snapshot = Snapshot(next, clock(), signal, failed)
        tell(before, next)
        return next
    }

    /* Files asks for the roots again when one appeared, went or was renamed, and for a family's folders when they changed. */
    private fun tell(before: List<FamilyRoot>?, after: List<FamilyRoot>) {
        val context = vault.context
        val authority = FilesRoots.authority(context)
        val was = before.orEmpty().associateBy { it.groupId }
        val now = after.associateBy { it.groupId }
        runCatching {
            if (before == null || was.mapValues { it.value.name } != now.mapValues { it.value.name }) context.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority), null)
            for (groupId in was.keys + now.keys) if (was[groupId]?.folders != now[groupId]?.folders)
                context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, FamilyDoc.Top(groupId).id), null)
        }
    }

    /*
     * The family's root, checked again first when a family appeared or went elsewhere since the last load (a leave or a
     * removal the app found): never answered from a family this phone let go of. Refused once the session ended.
     */
    fun require(groupId: String): FamilyRoot {
        if (vault.closed) throw SessionEnded()
        val held = snapshot
        if (held == null || held.signal != FamilyRootsSignal.now()) load()
        return roots.firstOrNull { it.groupId.equals(groupId, ignoreCase = true) } ?: throw FileNotFoundException(FamilyWords.NOT_IN_FAMILY)
    }

    private fun folderOf(doc: FamilyDoc.Node): Pair<FamilyRoot, FamilyRoot.Folder> {
        val root = require(doc.groupId)
        return root to (root.folder(doc.workspaceId) ?: throw FileNotFoundException(FamilyWords.NOT_IN_FAMILY))
    }

    /*
     * A node of a family folder, as the ledger opened it: its folder listed through the ledger when this process doesn't
     * hold it yet (the parent it was last seen under). Never a row opened another way, and never another workspace's.
     */
    fun node(doc: FamilyDoc.Node): Opened {
        folderOf(doc)
        return held(doc.workspaceId, doc.nodeId) ?: throw FileNotFoundException("This item no longer exists.")
    }

    /*
     * A family folder's node as the ledger opened it. One this process doesn't hold yet (a restart, Files reopening a
     * remembered document or tree) is found by listing, through the ledger, the folder it was last seen in, else the
     * folder the workspace's change feed puts it in (the feed only says where to look: the row kept is the listing's).
     * Listing a folder opens every folder above it too. Null when no listing holds it.
     */
    private fun held(workspaceId: String, id: String): Opened? {
        vault.item(workspaceId, id)?.let { return it }
        vault.parents[id]?.let { parent -> runCatching { vault.listChildren(parent, workspaceId) } }
        vault.item(workspaceId, id)?.let { return it }
        val parent = parentInFeed(workspaceId, id) ?: return null
        vault.listChildren(parent, workspaceId)
        return vault.item(workspaceId, id)
    }

    /* The folder the workspace's change feed last puts `id` in, read from the start; null when it names none or it was trashed. */
    private fun parentInFeed(workspaceId: String, id: String): String? {
        var cursor = 0
        var parent: String? = null
        repeat(MAX_FEED_PAGES) {
            val page = vault.api.changes(workspaceId, cursor)
            for (change in page.changes) {
                val node = change.node ?: continue
                if (node.id == id && node.workspaceId.equals(workspaceId, ignoreCase = true)) parent = node.parentId.takeIf { node.trashedAt == null }
            }
            if (!page.hasMore || page.nextCursor <= cursor) return parent
            cursor = page.nextCursor
        }
        return parent
    }

    /* The document a family id names, as a row. */
    fun document(doc: FamilyDoc): FamilyRow = when (doc) {
        is FamilyDoc.Top -> require(doc.groupId).let { FamilyRow(it.documentId, Document.MIME_TYPE_DIR, it.name, null, 0, null, null) }
        is FamilyDoc.Node -> {
            val (root, folder) = folderOf(doc)
            val item = node(doc)
            rowOf(root, folder, item, if (item.id == folder.rootId) null else summaries(root.groupId, listOf(item))[0])
        }
    }

    /* A family's folders (its top), or a folder's children listed through the ledger. */
    fun children(doc: FamilyDoc): List<FamilyRow> = when (doc) {
        is FamilyDoc.Top -> {
            val root = require(doc.groupId)
            root.folders.mapNotNull { folder ->
                val item = vault.item(folder.workspaceId, folder.rootId) ?: return@mapNotNull null
                rowOf(root, folder, item, null)
            }
        }
        is FamilyDoc.Node -> {
            val (root, folder) = folderOf(doc)
            val listed = vault.listChildren(doc.nodeId, folder.workspaceId).filter { it.node.workspaceId.equals(folder.workspaceId, ignoreCase = true) }
            // On display in Files now: polls list it again and tell Files when it changed (refreshShown).
            shown[doc] = clock() to signature(listed)
            val summaries = summaries(root.groupId, listed)
            listed.mapIndexed { index, item -> rowOf(root, folder, item, summaries[index]) }
        }
    }

    /* The family folders Files listed lately, with when and what they held. */
    private val shown = java.util.concurrent.ConcurrentHashMap<FamilyDoc.Node, Pair<Long, String>>()

    private fun signature(items: List<Opened>): String =
        items.map { "${it.id}|${it.node.parentId}|${it.node.metadataVersion}|${it.node.keyEpoch}|${it.node.currentVersion?.id}" }.sorted().joinToString("\n")

    /*
     * A poll (FilesPoll) for the family folders Files listed within `window`: each listed again through the ledger, and
     * Files told of every one whose children changed (another member's upload, rename, move or trash), as the personal
     * drive's feed tells it of its own. Family folders have no feed here, so this is how a folder on display stays
     * current. The folders told.
     */
    fun refreshShown(window: Long): List<FamilyDoc.Node> {
        val now = clock()
        val told = ArrayList<FamilyDoc.Node>()
        for ((doc, seen) in shown) {
            if (now - seen.first >= window) { shown.remove(doc); continue }
            val listed = try {
                folderOf(doc)
                vault.listChildren(doc.nodeId, doc.workspaceId).filter { it.node.workspaceId.equals(doc.workspaceId, ignoreCase = true) }
            } catch (error: NotAuthenticated) {
                throw error
            } catch (_: Exception) {
                continue
            }
            val signature = signature(listed)
            if (signature == seen.second) continue
            shown[doc] = seen.first to signature
            told.add(doc)
            runCatching { vault.context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(FilesRoots.authority(vault.context), doc.nodeId), null) }
        }
        return told
    }

    /* Each row's mark as the family's member list judges it (the app's family rows), in the mark's own word. */
    private fun summaries(groupId: String, items: List<Opened>): List<String?> =
        runCatching { sync.verdicts(items.map { it.node }, groupId).map { it.mark?.label } }.getOrElse { items.map { "Couldn’t check" } }

    private fun rowOf(root: FamilyRoot, folder: FamilyRoot.Folder, item: Opened, summary: String?): FamilyRow {
        val top = item.id == folder.rootId
        var flags = 0
        if (item.isFolder) {
            if (folder.writable) flags = flags or Document.FLAG_DIR_SUPPORTS_CREATE
        } else if (item.hasThumbnail) flags = flags or Document.FLAG_SUPPORTS_THUMBNAIL
        // What the app offers on a family item while its folder is writable: rename, move within the folder, Move to
        // Trash, a new version. The folder's top takes new items only.
        if (folder.writable && !top) {
            flags = flags or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE
            if (!item.isFolder) flags = flags or Document.FLAG_SUPPORTS_WRITE
        }
        return FamilyRow(FamilyDoc.Node(root.groupId, folder.workspaceId, item.id).id, mimeOf(item), if (top) folder.name else item.name,
            item.modifiedMillis, flags, if (item.isFolder) null else item.size, summary)
    }

    /* Whether `doc` sits under `parent`: in one family, under the family's top or up a folder's own parents. */
    fun isChild(parent: FamilyDoc, doc: FamilyDoc): Boolean {
        if (!parent.groupId.equals(doc.groupId, ignoreCase = true) || doc !is FamilyDoc.Node) return false
        val root = require(doc.groupId)
        val folder = root.folder(doc.workspaceId) ?: return false
        if (parent is FamilyDoc.Top) return true
        parent as FamilyDoc.Node
        if (!parent.workspaceId.equals(folder.workspaceId, ignoreCase = true)) return false
        // Up its own parents, each found through the ledger when this process doesn't hold it yet (a tree Files kept across
        // a restart); anything not under the tree's folder is outside it.
        var current: String? = doc.nodeId
        repeat(MAX_DEPTH) {
            val id = current ?: return false
            if (id == parent.nodeId) return true
            current = held(folder.workspaceId, id)?.node?.parentId
        }
        return false
    }

    /* A writable family folder's node: refused, with the app's words, where the app offers no change. */
    private fun writable(doc: FamilyDoc.Node): Pair<FamilyRoot.Folder, Opened> {
        val (root, folder) = folderOf(doc)
        if (root.unanswered) throw FileNotFoundException(FamilyWords.NO_ANSWER)
        if (!folder.writable) throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        return folder to node(doc)
    }

    /*
     * The current version's plaintext under the family folder's copies (opened/family/<workspace>/files/<node>/<version>),
     * downloaded under the folder's invalidation: a removal meanwhile writes nothing, and deletes what was there.
     */
    fun readCopy(doc: FamilyDoc.Node): File {
        val (_, folder) = folderOf(doc)
        val item = node(doc)
        val version = item.node.currentVersion?.id ?: throw FileNotFoundException("This file has no content yet.")
        val copies = FamilyCopies.folder(vault.context.cacheDir, folder.workspaceId) ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val file = File(copies, "files/${item.id.lowercase()}/$version")
        if (!file.exists()) vault.download(item.id, file, expectedVersionId = version, workspaceId = folder.workspaceId)
        return file
    }

    /*
     * Where another app writes a family file's new bytes: its own file under the family folder's edits (edits/family/
     * <workspace>/<node>/<random>, which every forget of the folder deletes, and no allowlist sweep), made under the
     * copies lock only while the folder stands and the session lasts, holding the current version first when the mode
     * keeps the contents (WriteModes: appending, or reading and writing without truncating).
     */
    /* The edit for another app opening a family file in `mode` (WriteModes). */
    fun editFor(doc: FamilyDoc.Node, mode: String): File = editCopy(doc, WriteModes.keepsContents(mode))

    fun editCopy(doc: FamilyDoc.Node, keepContents: Boolean): File {
        val (folder, item) = writable(doc)
        val source = if (keepContents) readCopy(doc) else null
        val epoch = vault.familyEpoch(folder.workspaceId)
        val edits = FamilyCopies.edits(vault.context.cacheDir, folder.workspaceId) ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val edit = File(edits, "${item.id.lowercase()}/${java.util.UUID.randomUUID()}")
        synchronized(FamilyCopies.LOCK) {
            if (vault.closed) throw SessionEnded()
            vault.familyWordsSince(folder.workspaceId, epoch)?.let { throw FileNotFoundException(it) }
            edit.parentFile?.mkdirs()
            if (source != null) source.copyTo(edit, overwrite = true) else edit.createNewFile()
        }
        return edit
    }

    /*
     * What another app wrote, queued as a new version of the file (TransferQueue.upload with its Family, #251's): the job
     * opens the family in its own vault, sends through the family write path and its gates, keeps its reservation on the
     * ledger (Reservations) from begin until settled, waits out a key change, and is retried by WorkManager until it lands
     * or the family lets the account go (endFamily), so a write-back that fails or whose process dies is never dropped.
     * Checked here first, nothing queued: the family again if anything moved since (a leave or a removal elsewhere), the
     * folder writable, the family's guard kept. The edit moves into the queue's own folder. The job's id.
     */
    fun writeBack(doc: FamilyDoc.Node, edit: File): java.util.UUID {
        if (!edit.exists()) throw FileNotFoundException(FamilyWords.OPEN_AGAIN)
        val (folder, item) = writable(doc)
        vault.requireGuardKept(folder.workspaceId)
        val parent = item.node.parentId ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        return queue(edit, item.name, item.metadata.mime, parent, item.id, TransferQueue.Family(doc.groupId.lowercase(), folder.workspaceId.lowercase()))
    }

    /* Tests: what queues a write-back (TransferQueue.upload), so a test can run the job it queued. */
    internal var queue: (file: File, name: String, mime: String?, folder: String, replacingId: String, family: TransferQueue.Family) -> java.util.UUID =
        { file, name, mime, folder, replacingId, family -> TransferQueue.upload(vault.context, file, name, mime, folder, replacingId, family) }

    /* A new folder, or an empty file whose bytes follow through a write, in a writable family folder. Its document id. */
    fun create(parentDoc: FamilyDoc.Node, mimeType: String, name: String): String {
        val (folder, parent) = writable(parentDoc)
        if (!parent.isFolder) throw FileNotFoundException("Choose a folder.")
        val made = if (mimeType == Document.MIME_TYPE_DIR) vault.createFolder(parent.id, name) else {
            val empty = File.createTempFile("new", null, vault.context.cacheDir)
            try {
                vault.upload(empty, name, mimeType.takeIf { it != "application/octet-stream" }, parent.id, null)
            } finally {
                empty.delete()
            }
        }
        return FamilyDoc.Node(parentDoc.groupId, folder.workspaceId, made.id).id
    }

    fun rename(doc: FamilyDoc.Node, name: String) {
        val (folder, item) = writable(doc)
        if (item.id == folder.rootId) throw FileNotFoundException(FamilyWords.UNAVAILABLE)
        vault.rename(item.id, name)
    }

    /* Within one family folder only, as the app moves; anything else is refused before anything is sent. */
    fun move(doc: FamilyDoc.Node, target: FamilyDoc.Node) {
        if (!doc.groupId.equals(target.groupId, ignoreCase = true) || !doc.workspaceId.equals(target.workspaceId, ignoreCase = true)) throw FileNotFoundException(FamilyWords.UNAVAILABLE)
        val (folder, item) = writable(doc)
        val (_, parent) = writable(target)
        if (item.id == folder.rootId || !parent.isFolder) throw FileNotFoundException(FamilyWords.UNAVAILABLE)
        vault.move(item.id, parent.id)
    }

    /* Move to Trash, as the app's. */
    fun delete(doc: FamilyDoc.Node) {
        val (folder, item) = writable(doc)
        if (item.id == folder.rootId) throw FileNotFoundException(FamilyWords.UNAVAILABLE)
        vault.trash(item.id)
    }

    fun thumbnail(doc: FamilyDoc.Node): ByteArray? {
        val (_, folder) = folderOf(doc)
        node(doc)
        return vault.thumbnail(doc.nodeId, folder.workspaceId)
    }

    companion object {
        private const val TTL_MS = 5 * 60_000L
        private const val RETRY_MS = 30_000L
        private const val MAX_DEPTH = 256
        private const val MAX_FEED_PAGES = 1_000

        fun mimeOf(item: Opened): String {
            if (item.isFolder) return Document.MIME_TYPE_DIR
            item.metadata.mime?.let { return it }
            val ext = item.name.substringAfterLast('.', "")
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
        }
    }
}
