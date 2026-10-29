package com.hushos.app.data

import java.util.concurrent.ConcurrentHashMap

/*
 * Node keys and opened rows, by workspace and node. A share or a link brings a key for an
 * id the server chose: kept under the id alone, a share naming one of this account's own
 * nodes would replace that node's key, and the next write under it would be sealed with a
 * key the server knows. Keyed by (workspace, node), another workspace's key never answers
 * for this account's own. A lookup by id alone (what the UI passes) takes this account's
 * own entry first, and another workspace's only when there is none.
 */
class NodeCache(private val ownWorkspace: () -> String?) {
    /* node id -> workspace id -> value: an id-only lookup stays one map read. */
    private val keys = ConcurrentHashMap<String, ConcurrentHashMap<String, ByteArray>>()
    private val rows = ConcurrentHashMap<String, ConcurrentHashMap<String, Opened>>()
    /*
     * Nodes the server said are gone (trashed from here, tombstoned in the feed, purged), by workspace and node as
     * rows are, until that workspace's row comes back: a share's node by the same id as one of this account's own
     * is another node. Not the rows dropped to be read again (`forget`, `forgetRows`): absence never means gone.
     */
    private val gone = ConcurrentHashMap<String, MutableSet<String>>()

    fun key(workspaceId: String, nodeId: String): ByteArray? = keys[nodeId]?.get(workspaceId)
    fun key(item: Opened): ByteArray? = key(item.node.workspaceId, item.id)
    fun row(workspaceId: String, nodeId: String): Opened? = rows[nodeId]?.get(workspaceId)

    /* By id alone: this account's own row, or another workspace's when this account has none by that id. */
    fun find(nodeId: String): Opened? {
        val byWorkspace = rows[nodeId] ?: return null
        ownWorkspace()?.let { own -> byWorkspace[own]?.let { return it } }
        return byWorkspace.values.firstOrNull()
    }

    /*
     * `find`, while the row is still somewhere a person can see it: not in the trash, and no folder above it
     * (as far as this device holds them, in the row's own workspace) in the trash either. Trashing a folder
     * marks only the folder, so a file inside stays an untrashed row the whole time it is gone.
     */
    fun live(nodeId: String, workspaceId: String? = null): Opened? {
        // In a given workspace only, when the caller knows which node it means (Info, after it showed one).
        val row = (if (workspaceId != null) row(workspaceId, nodeId) else find(nodeId)) ?: return null
        var cursor: Opened? = row
        var steps = 0
        while (cursor != null && steps++ < 256) {
            if (cursor.node.trashedAt != null) return null
            cursor = cursor.node.parentId?.let { row(row.node.workspaceId, it) }
        }
        return row
    }

    fun putKey(workspaceId: String, nodeId: String, key: ByteArray) {
        keys.getOrPut(nodeId) { ConcurrentHashMap() }[workspaceId] = key
    }

    /* A row and its key, under the workspace the row says it is in. */
    fun put(row: Opened, key: ByteArray) {
        putKey(row.node.workspaceId, row.id, key)
        rows.getOrPut(row.id) { ConcurrentHashMap() }[row.node.workspaceId] = row
        gone[row.id]?.remove(row.node.workspaceId)
    }

    /* Drops the row to be read again (its key stays, for children still wrapped under it). */
    fun forget(workspaceId: String, nodeId: String) {
        rows[nodeId]?.remove(workspaceId)
    }

    /* Drops the row because the server said it is gone: `gone` answers for it until it comes back. */
    fun remove(workspaceId: String, nodeId: String) {
        gone.getOrPut(nodeId) { ConcurrentHashMap.newKeySet() }.add(workspaceId)
        forget(workspaceId, nodeId)
    }

    fun gone(workspaceId: String, nodeId: String): Boolean = gone[nodeId]?.contains(workspaceId) == true

    fun forgetRows() = rows.clear()

    /*
     * Keeps a received share's root under the share's workspace, and only when that is not `own` and the
     * root is the share's node in it; refused, nothing is kept and this account's own entry stays as it was.
     */
    fun adoptShare(share: ShareView, own: String, row: Opened, key: ByteArray): Opened {
        checkShare(share, own)
        if (row.node.workspaceId != share.workspaceId || row.id != share.node.id) throw ShareRefused("This share does not match its folder.")
        put(row, key)
        return row
    }

    fun rowsIn(workspaceId: String): List<Opened> = rows.values.mapNotNull { it[workspaceId] }
}

/* A refusal written for people: shown as it is, never as "That didn’t work". */
open class Refused(val title: String, message: String) : Exception(message)

/* Rows and documents are sealed in envelope suite 1; any other is a later format this app can't read. */
const val ENVELOPE_SUITE = 1

class NewerFormat : Refused("Update HushOS", "This item was made by a newer version of HushOS. Update the app to open it.")

fun checkSuite(suite: Int) {
    if (suite != ENVELOPE_SUITE) throw NewerFormat()
}

class ShareRefused(message: String) : Refused("This share was refused", message)

/*
 * A received share is opened only into another workspace than this account's own, and only
 * for a node of the workspace it was sealed for: anything else would put a key the server
 * chose beside this account's own.
 */
fun checkShare(share: ShareView, ownWorkspace: String) {
    if (share.workspaceId == ownWorkspace) throw ShareRefused("This share points into your own drive and was refused.")
    if (share.node.workspaceId != share.workspaceId) throw ShareRefused("This share does not match its folder.")
}

/* A node the server answered a write with must be the one written, in the workspace written to; otherwise nothing is kept. */
fun checkWritten(node: NodeView, workspaceId: String, nodeId: String) {
    if (node.workspaceId != workspaceId || node.id != nodeId) throw ApiError(502, "HushOS answered with a different item than the one written. Nothing was kept.")
}
