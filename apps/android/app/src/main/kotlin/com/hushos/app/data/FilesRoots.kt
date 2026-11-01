package com.hushos.app.data

import android.content.Context
import android.provider.DocumentsContract

/*
 * What the file pickers and Files by Google are told. Files keeps a folder's listing until the folder's
 * children URI is notified (the cursor's notification URI, HushOSDocumentsProvider.queryChildDocuments),
 * so every write and every sync that changes a folder's children tells that folder here.
 */
object FilesRoots {
    /* The drive's top folder as the provider names it; every other document id is the node's id. */
    const val ROOT_DOCUMENT = "root"

    fun authority(context: Context) = "${context.packageName}.documents"

    /* The document id the provider hands out for a node, and the node a document id names (either form of the top folder). */
    fun documentId(nodeId: String, rootId: String?): String = if (nodeId == rootId) ROOT_DOCUMENT else nodeId
    fun nodeId(documentId: String, rootId: String): String = if (documentId == ROOT_DOCUMENT) rootId else documentId

    /*
     * Every document id Files may hold for a folder. The provider hands out "root" for the top folder, and also
     * answers to its node id (`nodeId`), so a listing opened by either is told; any other folder has one.
     */
    fun documentIds(folderId: String, rootId: String?): Set<String> =
        if (folderId == ROOT_DOCUMENT || (rootId != null && folderId == rootId)) setOfNotNull(ROOT_DOCUMENT, rootId) else setOf(folderId)

    /*
     * The folders whose listings a sync's touched ids changed: the folder each touched node now sits in, and every
     * touched id that is not known to be a file (the sync names the folders a change left or entered, and a removed
     * node's folder, by id). Nodes already gone from this device can't be asked, so they count as folders.
     */
    fun foldersOf(touched: Collection<String>, parentOf: (String) -> String?, isFile: (String) -> Boolean): Set<String> {
        val folders = LinkedHashSet<String>()
        for (id in touched) {
            parentOf(id)?.let { folders.add(it) }
            if (!isFile(id)) folders.add(id)
        }
        return folders
    }

    /* These folders' children changed: each listing Files holds of them is read again. `rootId`: this drive's top folder. */
    fun foldersChanged(context: Context, folders: Collection<String>, rootId: String?) {
        if (folders.isEmpty()) return
        val authority = authority(context)
        val ids = folders.flatMapTo(LinkedHashSet()) { documentIds(it, rootId) }
        runCatching { for (id in ids) context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, id), null) }
    }

    /* HushOS's root (signed in or out) and the root's listing. */
    fun changed(context: Context) {
        val authority = authority(context)
        runCatching {
            context.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority), null)
            context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, ROOT_DOCUMENT), null)
        }
    }
}
