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
import com.hushos.app.data.WriteBacks
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
    /* Kept from an earlier load because the family couldn't be checked now (no answer, left out of route 2): readable, written to only once accepted again. */
    val unanswered: Boolean = false,
) {
    /*
     * `epoch`: the folder's revocation count when the family was accepted (read before its sync). Kept from cache only
     * while that is still the count: a revocation since (a refusal or fork another vault found) is never undone by a load
     * that got no answer, and the folder is refused until a load accepts the family again.
     */
    data class Folder(val workspaceId: String, val rootId: String, val name: String, val writable: Boolean, val epoch: Long = 0L)

    val documentId: String get() = FamilyDoc.Top(groupId).id
    val rootId: String get() = FamilyDoc.PREFIX + groupId

    fun folder(workspaceId: String): Folder? = folders.firstOrNull { it.workspaceId.equals(workspaceId, ignoreCase = true) }

    /* The same root, read only until the family is accepted again. */
    fun readOnly(): FamilyRoot = copy(folders = folders.map { it.copy(writable = false) }, unanswered = true)

    companion object {
        /* An accepted family's root: only folders that opened through the ledger, writable as the app has them. */
        fun of(groupId: String, name: String, view: FamilyView, epochOf: (String) -> Long = { 0L }): FamilyRoot = FamilyRoot(groupId, name, view.areas.mapNotNull { area ->
            val root = area.root?.takeIf { area.openable } ?: return@mapNotNull null
            Folder(area.workspaceId, root.id, area.name!!, area.write == AreaWrite.WRITABLE, epochOf(area.workspaceId))
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

    /* A load now, whether or not the roots are due: Files asked to refresh a family's own listing (its folders). */
    fun reload(): List<FamilyRoot> = synchronized(loadLock) {
        snapshot?.let { snapshot = Snapshot(it.roots, Long.MIN_VALUE / 4, it.signal, it.failed) }
        loadHeld()
    }

    private fun loadHeld(): List<FamilyRoot> {
        snapshot?.let { if (!due()) return it.roots }
        if (vault.closed) throw SessionEnded()
        val signal = FamilyRootsSignal.now()
        val before = snapshot?.roots
        val kept = before.orEmpty().associateBy { it.groupId.lowercase() }
        val gone: List<FamilySync.Revised>
        val listed = try {
            sync.listReconciling().also { gone = it.second }.first
        } catch (error: NotAuthenticated) {
            throw error
        } catch (_: Exception) {
            // No answer: the roots it had stay, but never a folder revoked since it was accepted.
            val kept = before.orEmpty().mapNotNull(::unrevoked)
            snapshot = Snapshot(kept, clock(), signal, failed = true)
            tell(before, kept)
            return kept
        }
        var failed = false
        val wiped = HashSet<String>()
        val next = listed.filter { it.state == "active" }.mapNotNull { summary ->
            // Each folder's revocation count before the sync accepts it: a revocation landing after this read makes the root
            // fail its next check (the count moved), never pass it.
            val epochs = HashMap(vault.familyEpochs)
            when (val state = sync.sync(summary)) {
                is FamilyState.Accepted -> FamilyRoot.of(summary.id, summary.name, state.view) { ws -> epochs[ws.lowercase()]?.first ?: 0L }
                // No answer: the root it had stays readable (its ledger kept the family), but nothing is written into it
                // until a sync accepts the family again.
                is FamilyState.Failed -> {
                    if (state.removal) wiped.add(summary.id.lowercase())
                    if (state.words == FamilyWords.NO_ANSWER) { failed = true; kept[summary.id.lowercase()]?.let(::unrevoked)?.readOnly() } else null
                }
                FamilyState.Wiped -> { wiped.add(summary.id.lowercase()); null }
                else -> null
            }
        }
        // A family route 2 left out that the server hasn't said this account isn't in (a list caught between two states, or
        // route 5 not answered): its root stays, read only, until a not-member confirms the removal, so an edit open in it
        // still reaches the queue.
        val removed = gone.filter { it.state == FamilyState.Wiped || (it.state as? FamilyState.Failed)?.removal == true }.mapNotNull { it.groupId?.lowercase() }.toSet()
        // A removal this load confirmed: the family's transfers end as the app's own sync ends them (its pending saves and
        // their plaintext, their jobs and rows), only while this session is still the one signed in.
        for (groupId in removed + wiped) endTransfers(groupId)
        val shown = listed.map { it.id.lowercase() }.toSet()
        val pending = before.orEmpty().filter { it.groupId.lowercase() !in shown && it.groupId.lowercase() !in removed }.mapNotNull { unrevoked(it)?.readOnly() }
        if (pending.isNotEmpty()) failed = true
        val roots = next + pending
        snapshot = Snapshot(roots, clock(), signal, failed)
        tell(before, roots)
        return roots
    }

    /* A root kept from an earlier load, with only the folders not revoked since it was accepted; none if all were. */
    private fun unrevoked(root: FamilyRoot): FamilyRoot? =
        root.copy(folders = root.folders.filter { it.epoch == vault.familyEpoch(it.workspaceId) }).takeIf { it.folders.isNotEmpty() }

    /* A removed family's transfers ended (TransferQueue.endFamily), only while this session is still the one signed in. */
    private fun endTransfers(groupId: String) {
        runCatching {
            TransferQueue.endFamily(vault.context, groupId, vault.api.session, still = { !vault.closed }) { uploadId, workspaceId -> vault.api.abortUpload(uploadId, workspaceId) }
        }.onFailure { android.util.Log.w("HushOSFiles", "a removed family's transfers didn't end: ${it.javaClass.name}") }
    }

    /* Files asks for the roots again when one appeared, went or was renamed, and for a family's folders when they changed. */
    private fun tell(before: List<FamilyRoot>?, after: List<FamilyRoot>) {
        val context = vault.context
        val authority = FilesRoots.authority(context)
        val was = before.orEmpty().associateBy { it.groupId }
        val now = after.associateBy { it.groupId }
        runCatching {
            // What the roots show: the title, and whether it takes new items (FLAG_SUPPORTS_CREATE), which DocumentsUI keeps.
            fun shown(roots: Map<String, FamilyRoot>) = roots.mapValues { it.value.name to it.value.folders.any { folder -> folder.writable } }
            if (before == null || shown(was) != shown(now)) context.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority), null)
            for (groupId in was.keys + now.keys) if (was[groupId]?.folders != now[groupId]?.folders)
                context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, FamilyDoc.Top(groupId).id), null)
        }
    }

    /*
     * The family's root, checked again first whenever the roots are due (a family appeared or went elsewhere since the
     * last load, or the last load is old): never answered from a family this phone let go of, and a root kept read only
     * after no answer turns writable again once a load accepts it, even when Files reopens a document it remembered
     * without asking for roots or a listing. Refused once the session ended.
     */
    fun require(groupId: String): FamilyRoot {
        if (vault.closed) throw SessionEnded()
        if (due()) load()
        return roots.firstOrNull { it.groupId.equals(groupId, ignoreCase = true) } ?: throw FileNotFoundException(FamilyWords.NOT_IN_FAMILY)
    }

    private fun folderOf(doc: FamilyDoc.Node): Pair<FamilyRoot, FamilyRoot.Folder> {
        val root = require(doc.groupId)
        val folder = root.folder(doc.workspaceId) ?: throw FileNotFoundException(FamilyWords.NOT_IN_FAMILY)
        // Revoked since the family was accepted (another vault found a refusal or a fork): refused until a load accepts it again.
        if (folder.epoch != vault.familyEpoch(folder.workspaceId)) throw FileNotFoundException(vault.familyWordsSince(folder.workspaceId, folder.epoch) ?: FamilyWords.OPEN_AGAIN)
        return root to folder
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
        vault.parents[id]?.let { parent -> runCatching { relist(workspaceId, parent) } }
        vault.item(workspaceId, id)?.let { return it }
        val parent = parentInFeed(workspaceId, id) ?: return null
        relist(workspaceId, parent)
        return vault.item(workspaceId, id)
    }

    /*
     * A family folder's children listed again through the ledger, and every row this vault held under it that the listing
     * no longer has (moved elsewhere by another device, trashed, deleted) forgotten: no answer, and no tree check, is ever
     * made from where a node used to be.
     */
    private fun relist(workspaceId: String, folderId: String): List<Opened> {
        val listed = vault.listChildren(folderId, workspaceId).filter { it.node.workspaceId.equals(workspaceId, ignoreCase = true) }
        val ids = listed.map { it.id }.toSet()
        for (row in vault.nodes.rowsIn(workspaceId)) if (row.node.parentId == folderId && row.id !in ids) vault.forget(row.node.workspaceId, row.id)
        return listed
    }

    /* `folderId` listed again (`relist`); false, with its rows forgotten, when the server says it is gone or in the trash. */
    private fun relistUnlessGone(workspaceId: String, folderId: String): Boolean = try {
        relist(workspaceId, folderId)
        true
    } catch (error: Exception) {
        if (!com.hushos.app.data.FamilyUploads.folderGone(error)) throw error
        for (row in vault.nodes.rowsIn(workspaceId)) if (row.node.parentId == folderId) vault.forget(row.node.workspaceId, row.id)
        false
    }

    /*
     * A node's place confirmed with the server now (a tree check): the folder this vault last saw it in listed again,
     * and kept only when that listing still holds it there; else the folder the change feed now puts it in, listed. Null
     * when no listing holds it; throws when the server can't be asked. A folder's top has no parent and is the family's
     * sync's own.
     */
    private fun fresh(workspaceId: String, id: String): Opened? {
        val held = vault.item(workspaceId, id)
        if (held != null && held.node.parentId == null) return held
        val parent = held?.node?.parentId ?: vault.parents[id]
        // A folder gone or in the trash holds nothing: the feed says where the node went (never a failure to answer).
        if (parent != null && relistUnlessGone(workspaceId, parent)) {
            vault.item(workspaceId, id)?.takeIf { it.node.parentId == parent }?.let { return it }
        }
        val moved = parentInFeed(workspaceId, id) ?: return null
        relist(workspaceId, moved)
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
            val listed = relist(folder.workspaceId, doc.nodeId)
            // On display in Files now: polls list it again and tell Files when it changed (refreshShown).
            shown[doc] = clock() to signature(listed)
            val summaries = summaries(root.groupId, listed)
            listed.mapIndexed { index, item -> rowOf(root, folder, item, summaries[index]) }
        }
    }

    /* The family folders Files listed lately, with when and what they held. */
    private val shown = java.util.concurrent.ConcurrentHashMap<FamilyDoc.Node, Pair<Long, String>>()

    /* What a listing shows of its items: the server's rows and each file's pending save (its size and date). */
    private fun signature(items: List<Opened>): String = items.map {
        val pending = if (it.isFolder) null else WriteBacks.pendingMeta(vault.context, WriteBacks.slotOf(it.node.workspaceId, it.id))
        "${it.id}|${it.node.parentId}|${it.node.metadataVersion}|${it.node.keyEpoch}|${it.node.currentVersion?.id}|$pending"
    }.sorted().joinToString("\n")

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
                relist(doc.workspaceId, doc.nodeId)
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
        // A file with a pending save shows that save's size and date: the bytes a read returns.
        val pending = if (item.isFolder) null else WriteBacks.pendingMeta(vault.context, WriteBacks.slotOf(item.node.workspaceId, item.id))
        return FamilyRow(FamilyDoc.Node(root.groupId, folder.workspaceId, item.id).id, mimeOf(item), if (top) folder.name else item.name,
            pending?.second ?: item.modifiedMillis, flags, if (item.isFolder) null else pending?.first ?: item.size, summary)
    }

    /* Whether `doc` sits under `parent`: in one family, under the family's top or up a folder's own parents. */
    fun isChild(parent: FamilyDoc, doc: FamilyDoc): Boolean {
        if (!parent.groupId.equals(doc.groupId, ignoreCase = true) || doc !is FamilyDoc.Node) return false
        val root = require(doc.groupId)
        val folder = root.folder(doc.workspaceId) ?: return false
        if (parent is FamilyDoc.Top) return true
        parent as FamilyDoc.Node
        if (!parent.workspaceId.equals(folder.workspaceId, ignoreCase = true)) return false
        // Up its own parents, each place confirmed with the server now (fresh: never a cached row another device moved out of
        // the tree since, nor one this process never held, as after a restart); anything not under the tree's folder, or
        // whose place can't be confirmed, is outside it.
        var current: String? = doc.nodeId
        repeat(MAX_DEPTH) {
            val id = current ?: return false
            if (id == parent.nodeId) return true
            current = try {
                fresh(folder.workspaceId, id)?.node?.parentId
            } catch (error: NotAuthenticated) {
                throw error
            } catch (_: Exception) {
                return false
            }
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
    fun readCopy(doc: FamilyDoc.Node, strict: Boolean = false): File {
        // The folder's invalidation count before its access is checked: the download keeps nothing once it moved.
        val epoch = vault.familyEpoch(doc.workspaceId)
        val (_, folder) = folderOf(doc)
        // A save of it landed from its job's own vault since: the row held here may be the version before, so the folder
        // must answer (no fallback to that row: an app that reads then saves would write over the landed save).
        val landing = WriteBacks.landing(vault.context, slotOf(doc))
        val item = current(doc, strict || landing != null)
        landing?.let { WriteBacks.caughtUp(vault.context, slotOf(doc), it.id) }
        afterAccessChecked?.invoke()
        val version = item.node.currentVersion?.id ?: throw FileNotFoundException("This file has no content yet.")
        val copies = FamilyCopies.folder(vault.context.cacheDir, folder.workspaceId) ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val file = File(copies, "files/${item.id.lowercase()}/$version")
        if (!file.exists()) vault.download(item.id, file, expectedVersionId = version, workspaceId = folder.workspaceId, familyEpochAt = epoch)
        return file
    }

    /*
     * A file as its folder holds it now: the folder listed again through the ledger, so a version that landed since (another
     * member's, or a write-back the queue sent from another vault) is the one read and built on, never the row this vault
     * opened before. Without an answer, the row held, unless `strict` (an edit that keeps the contents: built on a version
     * that can't be checked, it could replace a newer one).
     */
    private fun current(doc: FamilyDoc.Node, strict: Boolean): Opened {
        val held = node(doc)
        val parent = held.node.parentId ?: return held
        try {
            // Its folder gone or in the trash: the file was moved out first, so it is looked for where the feed puts it.
            if (!relistUnlessGone(doc.workspaceId, parent)) vault.forget(doc.workspaceId, doc.nodeId)
        } catch (error: Exception) {
            if (strict || error is NotAuthenticated) throw error
            return held
        }
        // Moved by another device since: found where the change feed puts it now before it is called missing.
        return vault.item(doc.workspaceId, doc.nodeId) ?: held(doc.workspaceId, doc.nodeId) ?: throw FileNotFoundException("This item no longer exists.")
    }

    /*
     * Where another app writes a family file's new bytes: its own file under the family folder's edits (edits/family/
     * <workspace>/<node>/<random>, which every forget of the folder deletes, and no allowlist sweep), made under the
     * copies lock only while the folder stands and the session lasts, holding the current version first when the mode
     * keeps the contents (WriteModes: appending, or reading and writing without truncating).
     */
    /*
     * The edit for another app opening a family file in `mode` (WriteModes). `epoch`: the folder's invalidation count read
     * before anything was checked (the open's, which its save checks again).
     */
    fun editFor(doc: FamilyDoc.Node, mode: String, epoch: Long = vault.familyEpoch(doc.workspaceId)): File = editCopy(doc, WriteModes.keepsContents(mode), epoch)

    /* The folder's invalidation count now: read before an open checks anything, and carried to its save. */
    fun epochOf(doc: FamilyDoc.Node): Long = vault.familyEpoch(doc.workspaceId)

    fun editCopy(doc: FamilyDoc.Node, keepContents: Boolean, epoch: Long = vault.familyEpoch(doc.workspaceId)): File {
        val (folder, item) = writable(doc)
        afterAccessChecked?.invoke()
        if (!keepContents) return editCopy(doc, folder, item, epoch) { it.createNewFile(); true }!!
        // The file's pending save, when it has one (what another app last wrote, not landed yet, whatever its job's state):
        // the server's version is older than it, and an edit built on that would drop the save.
        editCopy(doc, folder, item, epoch) { WriteBacks.copyNewestTo(vault.context, slotOf(doc), it) }?.let { return it }
        val source = readCopy(doc, strict = true)
        return editCopy(doc, folder, item, epoch) { source.copyTo(it, overwrite = true); true }!!
    }

    /*
     * An edit filled by `fill` under the copies lock, only while the session lasts and the folder's invalidation count is
     * still `epoch` (read before its access was checked); null if `fill` had nothing.
     */
    private fun editCopy(doc: FamilyDoc.Node, folder: FamilyRoot.Folder, item: Opened, epoch: Long, fill: (File) -> Boolean): File? {
        // Durable (filesDir/edits/family/<workspace>): a save kept for a Retry outlives a cache clear; the folder's revocation
        // deletes it. The file it would replace is written beside it as it is made.
        val edits = FamilyCopies.edits(vault.context.filesDir, folder.workspaceId) ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val parent = item.node.parentId ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val target = WriteBacks.Target(item.node.workspaceId, item.id, item.name, item.metadata.mime, parent, doc.groupId.lowercase(), folder.workspaceId.lowercase())
        synchronized(FamilyCopies.LOCK) {
            if (vault.closed) throw SessionEnded()
            vault.familyWordsSince(folder.workspaceId, epoch)?.let { throw FileNotFoundException(it) }
            val edit = WriteBacks.editIn(File(edits, item.id.lowercase()), target)
            if (!fill(edit)) { WriteBacks.discardEdit(edit); return null }
            return edit
        }
    }

    private fun slotOf(doc: FamilyDoc.Node) = WriteBacks.slotOf(doc.workspaceId, doc.nodeId)

    /*
     * The file's pending save for an app reading it (`r`): a copy of its own under the family folder's copies (which every
     * forget of the folder deletes), made only while the family still holds the folder: the folder's invalidation count
     * read before its access is checked, and checked again, with the session, under the copies lock before anything is
     * copied, so a removal or refusal another vault lands in between writes no plaintext back. Null when it has none.
     */
    fun pendingRead(doc: FamilyDoc.Node): File? {
        val epoch = vault.familyEpoch(doc.workspaceId)
        val (_, folder) = folderOf(doc)
        val copies = FamilyCopies.folder(vault.context.cacheDir, folder.workspaceId) ?: throw FileNotFoundException(FamilyWords.COULDNT_CHECK_KEYS)
        val file = File(copies, "pending/${doc.nodeId.lowercase()}/${java.util.UUID.randomUUID()}")
        afterAccessChecked?.invoke()
        return synchronized(FamilyCopies.LOCK) {
            if (vault.closed) throw SessionEnded()
            vault.familyWordsSince(folder.workspaceId, epoch)?.let { throw FileNotFoundException(it) }
            file.takeIf { WriteBacks.copyNewestTo(vault.context, slotOf(doc), it) }
        }
    }

    /* Tests: runs after a read, a pending read or an edit checked the folder's access, before it copies anything. */
    @Volatile internal var afterAccessChecked: (() -> Unit)? = null

    /*
     * What another app wrote, once it closed the file (in the close callback itself, so saves keep the order the app
     * closed them in): the file's pending save (WriteBacks), and its slot's job queued (TransferQueue.enqueueSlot, with its
     * Family, #251's). The job sends the newest save the slot holds through the family write path and its gates: it opens
     * the family in its own vault, finds the file by workspace and node where it is now, keeps its reservation on the
     * ledger from begin until settled, waits out a key change, and is retried until it lands or the family lets the
     * account go (endFamily, which takes the slot with it). Nothing here asks the network: whatever blocks a write only
     * for now is the job's to wait out. A family that let go of the file before the close deleted its edits, so there is
     * nothing to save; a sign-out since the open keeps nothing (WriteBacks.save). `opened` is the file as the app opened
     * it. False when nothing was kept.
     */
    fun save(doc: FamilyDoc.Node, edit: File, opened: Opened, epoch: Long): Boolean {
        if (!edit.exists()) return false
        val parent = opened.node.parentId ?: return false
        val target = WriteBacks.Target(opened.node.workspaceId, opened.id, opened.name, opened.metadata.mime, parent, doc.groupId.lowercase(), doc.workspaceId.lowercase())
        // Its order among the file's saves (only read, never fails), then the edit marked as that save by one rename (no room
        // needed): from here it goes only once kept, dismissed, or let go of with its family or account.
        val number = WriteBacks.reserve(vault.context, slotOf(doc))
        val closed = WriteBacks.close(edit, number)
        // Kept only while the folder's invalidation count is still the one the open read before it checked anything, and
        // the session lasts, under the copies lock a removal's cleanup takes: a family let go of since keeps no plaintext.
        val kept = synchronized(FamilyCopies.LOCK) {
            if (vault.closed || vault.familyWordsSince(doc.workspaceId, epoch) != null) { WriteBacks.discardEdit(closed); null }
            else try {
                WriteBacks.stage(vault.context, vault.ledgerGeneration, target, closed, number) ?: run { WriteBacks.discardEdit(closed); null }
            } catch (failure: Exception) {
                // Not kept (a full disk, say): the closed edit stays, with a row to retry it when one can be written (else the
                // next reconcile makes it); a removal's cleanup deletes it.
                TransferQueue.stagingFailed(vault.context, target, closed, failure, vault.ledgerGeneration, number, epoch)
                throw EditKept(failure)
            }
        } ?: return false
        TransferQueue.enqueueSlot(vault.context, kept.slot, opened.name, target.family, vault.ledgerGeneration)
        // Its listing shows the save's size and date now: Files reads the folder again, by the plain node id its listing of
        // a family folder watches (queryChildDocuments), as every family write tells it (Vault.foldersChanged).
        FilesRoots.foldersChanged(vault.context, listOf(parent), null)
        return true
    }

    /* A save that couldn't be kept but whose edit was kept for a Retry (TransferQueue.stagingFailed): the edit must stay. */
    class EditKept(cause: Exception) : Exception("The save was kept for a retry.", cause)

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
