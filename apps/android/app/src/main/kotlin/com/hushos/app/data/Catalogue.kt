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

/*
 * Pulls the feed from `from` to the head, committing each page to the mirror; returns what arrived, and leaves this
 * vault's own cursor at the head. The app, the provider and the transfer jobs each hold a Vault over the one mirror:
 * a sync starts from where this vault's catalogue stands, never from the mirror's cursor, which another vault may
 * have moved past changes this catalogue never filed (applying a page twice is harmless: rows are replaced, the
 * cursor only moves forward).
 */
private fun Vault.pullFeed(workspaceId: String, from: Int): List<NodeChange> {
    val arrived = ArrayList<NodeChange>()
    var cursor = from
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
    catalogueCursor = cursor
    cataloguePulled = true
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

/* Opens rows into the catalogue (parents first) and files them under their parents. Only this workspace's rows: the feed is its own. */
private fun Vault.file(rows: List<NodeView>, workspaceId: String) {
    for (row in rows) {
        if (row.workspaceId != workspaceId) continue
        forget(workspaceId, row.id)
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
        val pulled = try { pullFeed(workspaceId, mirror.cursor(workspaceId)); true } catch (error: Unreachable) { if (mirror.cursor(workspaceId) == 0) throw error; false }
        // The cursor before the rows: whatever another vault adds between the two is pulled again by the next sync.
        var at = mirror.cursor(workspaceId)
        var (ordered, orphans) = parentsFirst(mirror.rows(workspaceId))
        if (orphans.isNotEmpty() && pulled) {
            // A row without its parent is a page this device missed: start over once.
            mirror.clear(workspaceId)
            pullFeed(workspaceId, 0)
            at = mirror.cursor(workspaceId)
            parentsFirst(mirror.rows(workspaceId)).let { ordered = it.first }
        }
        catalogueCursor = at
        catalogueChildren.clear()
        file(ordered, workspaceId)
        catalogueState = CatalogueState.READY
        pulled
    } catch (error: Exception) {
        catalogueState = CatalogueState.FAILED
        throw error
    }
}

/*
 * Pulls what changed since this catalogue's cursor and files it; returns the ids that
 * changed (and the folders they left, entered or were removed from), or null when the
 * server was not asked because the catalogue had to be built first and opened from the
 * phone alone. Files is told of every folder whose children changed.
 */
fun Vault.sync(): Set<String>? = synchronized(syncLock) {
    if (catalogueState != CatalogueState.READY) return if (buildCatalogue()) emptySet() else null
    val workspaceId = loadWorkspace().workspaceId
    val changes = pullFeed(workspaceId, catalogueCursor)
    if (changes.isEmpty()) return emptySet()
    val touched = HashSet<String>()
    val rows = ArrayList<NodeView>()
    for (change in changes) {
        when (change.kind) {
            "node" -> {
                val node = change.node ?: continue
                nodes.row(workspaceId, node.id)?.node?.parentId?.let { old -> if (old != node.parentId) { catalogueChildren[old]?.remove(node.id); touched.add(old) } }
                rows.add(node)
                touched.add(node.id)
                node.parentId?.let { touched.add(it) }
            }
            "tombstone" -> {
                val id = change.nodeId ?: continue
                (nodes.row(workspaceId, id)?.node?.parentId ?: parents[id])?.let { catalogueChildren[it]?.remove(id); touched.add(it) }
                remove(workspaceId, id)
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
            nodes.row(workspaceId, child)?.let { below.add(it.node) }
            queue.add(child)
        }
    }
    val batch = (rows + below).map { it.id }.toSet()
    val (ordered, orphans) = parentsFirst(rows + below) { id -> id !in batch && nodes.row(workspaceId, id) != null }
    file(ordered, workspaceId)
    if (orphans.isNotEmpty()) {
        // A row under a folder this device never saw: the next build fills the gap.
        android.util.Log.w("HushOSSync", "sync: ${orphans.size} rows without an open parent")
        catalogueState = CatalogueState.IDLE
    }
    foldersChanged(FilesRoots.foldersOf(touched, parentOf = { id -> nodes.row(workspaceId, id)?.node?.parentId ?: parents[id] },
        isFile = { id -> nodes.row(workspaceId, id)?.isFolder == false }))
    return touched
}

/* This folder's children from the catalogue, or null when the catalogue cannot answer for it. */
fun Vault.catalogueChildren(folderId: String): List<Opened>? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    // Only this workspace's own folder: an id-only lookup could have found a share's node by the same id.
    nodes.row(ws, folderId) ?: return null
    return catalogueChildren[folderId].orEmpty().mapNotNull { nodes.row(ws, it) }.filter { it.node.trashedAt == null }
        .sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
}

/*
 * Everything live in this workspace, for Recent and search: not trashed, and no trashed folder
 * above it. Trashing a folder marks only the folder, so what is inside it is ruled out by its
 * ancestors (the web catalogue's rule). Answers are remembered for the one call.
 */
fun Vault.catalogueAll(): List<Opened> {
    if (catalogueState != CatalogueState.READY) return emptyList()
    val ws = workspaceId
    val live = HashMap<String, Boolean>()
    fun isLive(item: Opened): Boolean = live[item.id] ?: run {
        val parent = item.node.parentId?.let { nodes.row(ws, it) }
        (item.node.trashedAt == null && (parent == null || isLive(parent))).also { live[item.id] = it }
    }
    return nodes.rowsIn(ws).filter { isLive(it) }
}

fun Vault.catalogueRecents(limit: Int): List<Opened>? {
    if (catalogueState != CatalogueState.READY) return null
    // Folders included, as the web's Recent and iOS list them; the top folder itself is not a recent item.
    return catalogueAll().filter { it.node.parentId != null && (it.isFolder || it.node.currentVersion != null) }.sortedWith(byRecent).take(limit)
}

/* Trashed rows, newest first, as the server lists them; the id breaks ties so the order holds between loads. */
fun Vault.catalogueTrash(): List<TrashItem>? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    return nodes.rowsIn(ws).filter { it.node.trashedAt != null }
        .sortedWith(compareByDescending<Opened> { it.node.trashedAt }.thenBy { it.id })
        .map { item -> TrashItem(item, item.node.parentId?.let { nodes.row(ws, it)?.node?.trashedAt } != null, folderName(item.node.parentId)) }
}
