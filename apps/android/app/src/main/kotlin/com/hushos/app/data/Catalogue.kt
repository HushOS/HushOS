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

/* This vault's own cursor no longer describes the mirror (cleared since, or mid-refill): its catalogue is built again. */
private class StaleCursor : Exception()

/* What a pull brought, and whether it had to clear the mirror and start over (a `resync`). */
private class Pulled(val changes: List<NodeChange>, val reset: Boolean)

/*
 * Pulls the feed to the head, committing each page to the mirror, and leaves this vault's own cursor (and the mirror
 * generation it belongs to) at the head. The app, the provider and the transfer jobs each hold a Vault over the one
 * mirror. A sync starts from `own`, where this vault's catalogue stands, not the mirror's cursor, which another vault
 * may have moved past changes this catalogue never filed (applying a page twice is harmless: rows are replaced, the
 * cursor only moves forward). That holds only within one generation of a whole mirror: after a clear, or while the
 * refill after one is unfinished (it failed partway), a cursor of its own would move the mirror's past rows it never
 * got back, and every later cold build would leave them out. Then `own` throws StaleCursor and the caller rebuilds,
 * pulling from the mirror's cursor (null), which carries the refill on. Held under the mirror's feed lock throughout.
 */
private fun Vault.pullFeed(workspaceId: String, own: Int?): Pulled = synchronized(mirror.feedLock) {
    val state = mirror.state(workspaceId)
    if (own != null && (state.generation != catalogueGeneration || state.refilling)) throw StaleCursor()
    val arrived = ArrayList<NodeChange>()
    var cursor = own ?: state.cursor
    var refilling = state.refilling
    var reset = false
    var first = true
    while (true) {
        val page = api.changes(workspaceId, cursor, FEED_PAGE)
        // `resync` speaks of the cursor a pull starts from (the web client's rule): the later pages of a refill sit below
        // the server's dropped tombstones by nature, and heeding it there would start the refill over for ever.
        if (first && page.resync && cursor > 0) {
            // The cursor predates what the server still remembers: start over from nothing, in a new generation.
            mirror.clear(workspaceId)
            arrived.clear()
            cursor = 0
            refilling = true
            reset = true
            continue
        }
        mirror.apply(workspaceId, page.changes, page.nextCursor)
        arrived.addAll(page.changes)
        first = false
        cursor = page.nextCursor
        if (!page.hasMore) break
    }
    if (refilling) mirror.refilled(workspaceId)
    catalogueCursor = cursor
    catalogueGeneration = mirror.state(workspaceId).generation
    cataloguePulled = true
    Pulled(arrived, reset)
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
        val pulled = try { pullFeed(workspaceId, null); true } catch (error: Unreachable) { if (mirror.cursor(workspaceId) == 0) throw error; false }
        // Where the mirror stands read with its rows, so the cursor this catalogue keeps is the one those rows are at.
        var (held, at) = synchronized(mirror.feedLock) { mirror.rows(workspaceId) to mirror.state(workspaceId) }
        var (ordered, orphans) = parentsFirst(held)
        if (orphans.isNotEmpty() && pulled) {
            // A row without its parent is a page this device missed: start over once.
            synchronized(mirror.feedLock) { mirror.clear(workspaceId) }
            pullFeed(workspaceId, null)
            synchronized(mirror.feedLock) { held = mirror.rows(workspaceId); at = mirror.state(workspaceId) }
            ordered = parentsFirst(held).first
        }
        catalogueCursor = at.cursor
        catalogueGeneration = at.generation
        catalogueChildren.clear()
        file(ordered, workspaceId)
        // Built from a whole mirror at the head of the feed: a row this vault still holds that the mirror doesn't, last
        // changed at or before the mirror's cursor, was deleted for good (a refill after a resync carries no tombstones).
        // It goes, marked gone, as its tombstone would have had it; a row newer than the cursor (a write that landed
        // since the pull, or one without a sequence) can't be judged yet and stays.
        if (pulled && !at.refilling) {
            val mirrored = held.mapTo(HashSet()) { it.id }
            for (row in nodes.rowsIn(workspaceId)) if (row.id !in mirrored && row.node.changeSeq?.let { it <= at.cursor } == true) remove(workspaceId, row.id)
        }
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
    // Not ready with a catalogue already filed (a rebuild threw, or a sync found rows under a folder it never saw):
    // built again against what was filed, so Files hears what changed, as from any sync. A first build tells nobody,
    // since nothing was listed from it yet.
    if (catalogueState != CatalogueState.READY && (owedFiled != null || catalogueChildren.isNotEmpty())) return rebuildCatalogue(loadWorkspace().workspaceId)
    if (catalogueState != CatalogueState.READY) return if (buildCatalogue()) emptySet() else null
    val workspaceId = loadWorkspace().workspaceId
    val pulled = try { pullFeed(workspaceId, catalogueCursor) } catch (stale: StaleCursor) { null }
    // The mirror was cleared (by this pull's resync or another vault's) or is mid-refill: the catalogue starts again from it.
    if (pulled == null || pulled.reset) return rebuildCatalogue(workspaceId)
    val changes = pulled.changes
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

/*
 * The catalogue built again from the mirror, the refill carried on first, inside a sync: returns what differs from the
 * catalogue it replaces (as a sync's touched set: the nodes, the folders they left and entered), or null when the
 * server was out of reach, and tells Files of those folders. What was filed before is kept (`owedFiled`) until a
 * rebuild succeeds: one that throws leaves the catalogue FAILED, and the sync that builds it next must still compare
 * with it, or the folders that changed meanwhile are never told (that sync's cursor is current by then).
 */
private fun Vault.rebuildCatalogue(workspaceId: String): Set<String>? {
    fun filed(): Map<String, Pair<String, Int?>> {
        val out = HashMap<String, Pair<String, Int?>>()
        for ((parent, children) in catalogueChildren) for (child in children) nodes.row(workspaceId, child)?.let { out[child] = parent to it.node.changeSeq }
        return out
    }
    val before = owedFiled ?: filed().also { owedFiled = it }
    catalogueState = CatalogueState.IDLE
    val pulled = buildCatalogue()
    owedFiled = null
    val after = filed()
    val touched = HashSet<String>()
    for (id in before.keys + after.keys) {
        val was = before[id]
        val now = after[id]
        if (was == now) continue
        touched.add(id)
        was?.let { touched.add(it.first) }
        now?.let { touched.add(it.first) }
    }
    foldersChanged(FilesRoots.foldersOf(touched, parentOf = { id -> after[id]?.first ?: before[id]?.first }, isFile = { id -> nodes.row(workspaceId, id)?.isFolder == false }))
    return if (pulled) touched else null
}

/* This folder's children from the catalogue, or null when the catalogue cannot answer for it. */
fun Vault.catalogueChildren(folderId: String): List<Opened>? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    // Only this workspace's own folder: an id-only lookup could have found a share's node by the same id.
    nodes.row(ws, folderId) ?: return null
    // Only what still lives here: an id filed under a folder it has since left is not listed in it.
    return catalogueChildren[folderId].orEmpty().mapNotNull { nodes.row(ws, it) }
        .filter { it.node.trashedAt == null && it.node.parentId.equals(folderId, ignoreCase = true) }
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

fun Vault.catalogueRecents(limit: Int, keep: (Opened) -> Boolean = { true }): Recents? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    // Folders included, as the web's Recent and iOS list them; the top folder itself is not a recent item.
    val found = catalogueAll().filter { it.node.parentId != null && (it.isFolder || it.node.currentVersion != null) }
    return Recents(found, limit, keep) { nodes.row(ws, it)?.node?.parentId }
}

/* Trashed rows, newest first, as the server lists them; the id breaks ties so the order holds between loads. */
fun Vault.catalogueTrash(): List<TrashItem>? {
    if (catalogueState != CatalogueState.READY) return null
    val ws = workspaceId
    return nodes.rowsIn(ws).filter { it.node.trashedAt != null }
        .sortedWith(compareByDescending<Opened> { it.node.trashedAt }.thenBy { it.id })
        .map { item -> TrashItem(item, item.node.parentId?.let { nodes.row(ws, it)?.node?.trashedAt } != null, folderName(item.node.parentId)) }
}
