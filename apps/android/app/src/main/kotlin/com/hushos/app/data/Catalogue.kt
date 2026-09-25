package com.hushos.app.data

import java.util.concurrent.ConcurrentHashMap

/*
 * The catalogue, as the web builds one from its mirror: the whole workspace
 * opened in memory, parents first, so folders, recents, trash and search
 * answer without a request. The first build pulls the entire change feed
 * (a feed is state, not a log: every node appears once, as it is now); after
 * that a sync pulls only what changed since the cursor. Shared folders live in
 * other workspaces and keep going to the network.
 */
enum class CatalogueState { IDLE, BUILDING, READY, FAILED }

private const val FEED_PAGE = 500

/* Pulls the feed from the mirror's cursor to the head, committing each page; returns what arrived. */
private fun Vault.pullFeed(workspaceId: String): List<NodeChange> {
    val arrived = ArrayList<NodeChange>()
    var cursor = mirror.cursor(workspaceId)
    while (true) {
        val page = api.changes(workspaceId, cursor, FEED_PAGE)
        if (page.resync) {
            // The cursor predates what the server still remembers: start over from nothing.
            mirror.clear(workspaceId)
            cursor = 0
            continue
        }
        mirror.apply(workspaceId, page.changes, page.nextCursor)
        arrived.addAll(page.changes)
        cursor = page.nextCursor
        if (!page.hasMore) break
    }
    return arrived
}

/* Rows in an order every parent precedes its children; rows whose parent is missing come back separately. */
private fun parentsFirst(rows: List<NodeView>, known: (String) -> Boolean = { false }): Pair<List<NodeView>, List<NodeView>> {
    val byId = rows.associateBy { it.id }
    val children = HashMap<String, MutableList<NodeView>>()
    val roots = ArrayList<NodeView>()
    val orphans = ArrayList<NodeView>()
    for (row in rows) {
        val parent = row.parentId
        when {
            // A parent already open (a sync's batch sits under the catalogue) starts a chain like a root.
            parent == null || (known(parent) && !byId.containsKey(parent)) -> roots.add(row)
            byId.containsKey(parent) -> children.getOrPut(parent) { ArrayList() }.add(row)
            else -> orphans.add(row)
        }
    }
    val ordered = ArrayList<NodeView>()
    val queue = ArrayDeque(roots)
    while (queue.isNotEmpty()) {
        val node = queue.removeFirst()
        ordered.add(node)
        children[node.id]?.let { queue.addAll(it) }
    }
    return ordered to orphans
}

/* Opens rows into the catalogue (parents first) and files them under their parents. */
private fun Vault.file(rows: List<NodeView>) {
    for (row in rows) {
        forget(row.id)
        runCatching { open(row) }.onSuccess {
            row.parentId?.let { parent ->
                rememberParent(row.id, parent)
                catalogueChildren.getOrPut(parent) { ConcurrentHashMap.newKeySet() }.add(row.id)
            }
        }
    }
}

/*
 * Builds the catalogue for this account's workspace; a second call while ready
 * is free. Returns whether the feed was pulled: false when the tree opened from
 * the phone alone because the server was out of reach, or nothing was built.
 */
fun Vault.buildCatalogue(): Boolean = synchronized(syncLock) {
    if (catalogueState == CatalogueState.READY) return false
    val workspaceId = loadWorkspace().workspaceId
    catalogueState = CatalogueState.BUILDING
    try {
        // One workspace per device: another account's tree is not kept beside this one.
        for (other in mirror.workspaces()) if (other != workspaceId) mirror.clear(other)
        // No network: the tree already on this phone opens as it was; the next sync catches up.
        val pulled = try { pullFeed(workspaceId); true } catch (error: Unreachable) { if (mirror.cursor(workspaceId) == 0) throw error; false }
        var (ordered, orphans) = parentsFirst(mirror.rows(workspaceId))
        if (orphans.isNotEmpty() && pulled) {
            // A row without its parent is a page this device missed: start over once.
            mirror.clear(workspaceId)
            pullFeed(workspaceId)
            parentsFirst(mirror.rows(workspaceId)).let { ordered = it.first }
        }
        catalogueChildren.clear()
        file(ordered)
        catalogueState = CatalogueState.READY
        pulled
    } catch (error: Exception) {
        catalogueState = CatalogueState.FAILED
        throw error
    }
}

/*
 * Pulls what changed since the cursor and files it; returns the ids that
 * changed (and their folders), or null when the server was not asked because
 * the catalogue had to be built first and opened from the phone alone.
 */
fun Vault.sync(): Set<String>? = synchronized(syncLock) {
    if (catalogueState != CatalogueState.READY) return if (buildCatalogue()) emptySet() else null
    val workspaceId = loadWorkspace().workspaceId
    val changes = pullFeed(workspaceId)
    if (changes.isEmpty()) return emptySet()
    val touched = HashSet<String>()
    val rows = ArrayList<NodeView>()
    for (change in changes) {
        when (change.kind) {
            "node" -> {
                val node = change.node ?: continue
                opened[node.id]?.node?.parentId?.let { old -> if (old != node.parentId) catalogueChildren[old]?.remove(node.id) }
                rows.add(node)
                touched.add(node.id)
                node.parentId?.let { touched.add(it) }
            }
            "tombstone" -> {
                val id = change.nodeId ?: continue
                (opened[id]?.node?.parentId ?: parents[id])?.let { catalogueChildren[it]?.remove(id); touched.add(it) }
                forget(id)
                touched.add(id)
            }
        }
    }
    // Changed rows may include a folder whose key rotated: its children are re-opened after it.
    val changedIds = rows.map { it.id }.toSet()
    val below = ArrayList<NodeView>()
    val queue = ArrayDeque(rows.map { it.id })
    while (queue.isNotEmpty()) {
        val id = queue.removeFirst()
        for (child in catalogueChildren[id].orEmpty()) if (child !in changedIds) {
            opened[child]?.let { below.add(it.node) }
            queue.add(child)
        }
    }
    val batch = (rows + below).map { it.id }.toSet()
    val (ordered, orphans) = parentsFirst(rows + below) { id -> id !in batch && opened.containsKey(id) }
    file(ordered)
    if (orphans.isNotEmpty()) {
        // A row under a folder this device never saw: the next build fills the gap.
        android.util.Log.w("HushOSSync", "sync: ${orphans.size} rows without an open parent")
        catalogueState = CatalogueState.IDLE
    }
    return touched
}

/* This folder's children from the catalogue, or null when the catalogue cannot answer for it. */
fun Vault.catalogueChildren(folderId: String): List<Opened>? {
    if (catalogueState != CatalogueState.READY) return null
    val folder = opened[folderId] ?: return null
    if (folder.node.workspaceId != workspaceId) return null
    return catalogueChildren[folderId].orEmpty().mapNotNull { opened[it] }.filter { it.node.trashedAt == null }
        .sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
}

/* Everything opened in this workspace, for search. */
fun Vault.catalogueAll(): List<Opened> {
    if (catalogueState != CatalogueState.READY) return emptyList()
    val ws = workspaceId
    return opened.values.filter { it.node.workspaceId == ws && it.node.trashedAt == null }
}

fun Vault.catalogueRecents(limit: Int): List<Opened>? {
    if (catalogueState != CatalogueState.READY) return null
    return catalogueAll().filter { !it.isFolder && it.node.currentVersion != null }.sortedByDescending { it.modifiedMillis ?: 0L }.take(limit)
}

/* Trashed rows, newest first, as the server lists them; the id breaks ties so the order holds between loads. */
fun Vault.catalogueTrash(): List<TrashItem>? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    return opened.values.filter { it.node.workspaceId == ws && it.node.trashedAt != null }
        .sortedWith(compareByDescending<Opened> { it.node.trashedAt }.thenBy { it.id })
        .map { item -> TrashItem(item, item.node.parentId?.let { opened[it]?.node?.trashedAt } != null) }
}
