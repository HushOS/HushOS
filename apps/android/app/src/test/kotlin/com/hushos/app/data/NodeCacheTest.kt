package com.hushos.app.data

import com.hushos.core.NodeMetadata
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.json.JSONObject
import org.junit.Test

/*
 * A share's key arrives for a node id the server chose. If it could land where this account's own
 * node key sits, the next write under that node would be sealed with a key the server knows. These
 * hold the cache to its rule: a share into the own workspace is refused and changes nothing, and a
 * foreign entry by the same id never answers for the own workspace.
 */
class NodeCacheTest {
    private val own = "6f1c2b3a-0000-4000-8000-0000000000a1"
    private val theirs = "6f1c2b3a-0000-4000-8000-0000000000b2"
    private val nodeId = "6f1c2b3a-0000-4000-8000-000000000001"
    private val ownKey = ByteArray(32) { 1 }
    private val serverKey = ByteArray(32) { 2 }

    private fun node(ws: String, id: String = nodeId) = NodeView(id, ws, "parent", "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null)
    private fun row(ws: String, id: String = nodeId) = Opened(node(ws, id), NodeMetadata("Folder", null, null, null, emptyMap()))
    private fun share(ws: String, nodeWs: String = ws) = ShareView("share-1", ws, "editor", "", 1uL, "", "granter", "", "", node(nodeWs), ServedIdentity(1uL, "", ""))

    private fun cacheWithOwnNode() = NodeCache { own }.also { it.put(row(own), ownKey) }

    @Test
    fun aShareIntoTheOwnWorkspaceIsRefusedAndTheOwnKeyStays() {
        val cache = cacheWithOwnNode()
        val refused = assertThrows(ShareRefused::class.java) { cache.adoptShare(share(own), own, row(own), serverKey) }
        assertEquals("This share points into your own drive and was refused.", refused.message)
        assertArrayEquals(ownKey, cache.key(own, nodeId))
    }

    @Test
    fun aShareWhoseNodeIsInAnotherWorkspaceIsRefused() {
        val cache = cacheWithOwnNode()
        // The share claims a foreign workspace, its node the account's own: the node's key would be the server's.
        assertThrows(ShareRefused::class.java) { cache.adoptShare(share(theirs, nodeWs = own), own, row(own), serverKey) }
        assertArrayEquals(ownKey, cache.key(own, nodeId))
        assertNull(cache.key(theirs, nodeId))
    }

    @Test
    fun aForeignShareNamingAnOwnNodeIdNeverAnswersForTheOwnWorkspace() {
        val cache = cacheWithOwnNode()
        cache.adoptShare(share(theirs), own, row(theirs), serverKey)
        assertArrayEquals(ownKey, cache.key(own, nodeId))
        assertArrayEquals(serverKey, cache.key(theirs, nodeId))
        // What the UI asks by id alone is the account's own node.
        assertEquals(own, cache.find(nodeId)?.node?.workspaceId)
        assertArrayEquals(ownKey, cache.key(cache.find(nodeId)!!))
    }

    @Test
    fun withNoOwnEntryAForeignKeyStillDoesNotSatisfyAnOwnLookup() {
        val cache = NodeCache { own }
        val foreign = cache.adoptShare(share(theirs), own, row(theirs), serverKey)
        assertNull(cache.key(own, nodeId))
        assertNull(cache.row(own, nodeId))
        // Found by id only as what it is: the other workspace's node, which writes then address there.
        assertSame(foreign, cache.find(nodeId))
    }

    @Test
    fun aWriteAnsweredWithANodeOfAnotherWorkspaceOrIdIsNotKept() {
        assertThrows(ApiError::class.java) { checkWritten(node(theirs), own, nodeId) }
        assertThrows(ApiError::class.java) { checkWritten(node(own, "6f1c2b3a-0000-4000-8000-000000000002"), own, nodeId) }
        checkWritten(node(own), own, nodeId)
    }

    @Test
    fun aRowServedInALaterEnvelopeSuiteIsRefusedAndOneWithoutASuiteIsSuiteOne() {
        fun served(suite: String?) = NodeView.from(JSONObject("""{"id":"$nodeId","workspaceId":"$own","parentId":null,"kind":"folder","keyEpoch":1,
            "parentKeyEpoch":1,"keyEnvelope":"","metadataVersion":1,"metadataEnvelope":"","currentVersion":null,"trashedAt":null${suite?.let { ",\"envelopeSuite\":$it" } ?: ""}}"""))
        assertThrows(NewerFormat::class.java) { checkSuite(served("2").envelopeSuite) }
        checkSuite(served(null).envelopeSuite)
        checkSuite(served("1").envelopeSuite)
    }

    /*
     * Info and the lists read the same rows. Trashing a folder marks only the folder, so a file inside it
     * stays an untrashed row: `find` still answers with it (what Info showed, with live Share and Tags, after
     * the folder went to the Trash on another device), `live` does not. A row of its own in the trash is not
     * live either, and a trashed folder of another workspace never hides this one's row.
     */
    @Test
    fun aRowInsideATrashedFolderOrTrashedItselfIsNotLive() {
        val cache = NodeCache { own }
        fun put(id: String, parent: String?, trashed: Boolean = false, ws: String = own) = cache.put(
            Opened(NodeView(id, ws, parent, "file", 1uL, 1uL, "", 1uL, "", null, if (trashed) "2026-10-29T10:00:00Z" else null, null, null), NodeMetadata(id, null, null, null, emptyMap())),
            ownKey,
        )
        put("root", null)
        put("trip", "root", trashed = true)
        put("days", "trip")
        put("photo.jpg", "days")
        put("notes.md", "root")
        put("old.txt", "root", trashed = true)
        assertEquals("photo.jpg", cache.find("photo.jpg")?.id)
        assertNull(cache.live("photo.jpg"))
        assertNull(cache.live("days"))
        assertNull(cache.live("old.txt"))
        assertEquals("notes.md", cache.live("notes.md")?.id)
        assertNull(cache.live("never-seen"))
        // Ancestors are looked up in the row's own workspace: another workspace's trashed folder by the same id
        // says nothing about this one's tree, and this one's trashed folder hides nothing of a share's.
        put("root", null, trashed = true, ws = theirs)
        assertEquals("notes.md", cache.live("notes.md")?.id)
        put("shared.pdf", "trip", ws = theirs)
        assertEquals("shared.pdf", cache.live("shared.pdf")?.id)
    }

    /*
     * Absence alone never means gone: rows forgotten to be read again (every row after a rotation, one row a catalogue
     * update reopens) are not removed. Only what the server said is gone is, until a row by that id comes back.
     */
    @Test
    fun onlyARemovalMarksARowGoneAndItsReturnClearsIt() {
        val cache = NodeCache { own }
        fun row(id: String) = Opened(NodeView(id, own, "root", "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))
        cache.put(row("a.txt"), ownKey)
        cache.put(row("b.txt"), ownKey)
        cache.forget(own, "a.txt")
        cache.forgetRows()
        assertNull(cache.find("a.txt"))
        assertEquals(false, cache.gone(own, "a.txt"))
        assertEquals(false, cache.gone(own, "b.txt"))
        cache.put(row("b.txt"), ownKey)
        cache.remove(own, "b.txt")
        assertNull(cache.find("b.txt"))
        assertEquals(true, cache.gone(own, "b.txt"))
        // Restored: back, and no longer gone.
        cache.put(row("b.txt"), ownKey)
        assertEquals(false, cache.gone(own, "b.txt"))
    }

    /*
     * A received share's node can carry the same id as one of this account's own; they are two nodes. Removing one
     * left both marked gone, and Info, which asks about removal before liveness, closed on the one still there.
     */
    @Test
    fun aRemovalMarksOnlyItsOwnWorkspacesNode() {
        val cache = NodeCache { own }
        fun row(ws: String) = Opened(NodeView(nodeId, ws, "parent", "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata("f", null, null, null, emptyMap()))
        cache.put(row(own), ownKey)
        cache.put(row(theirs), serverKey)
        cache.remove(own, nodeId)
        assertEquals(true, cache.gone(own, nodeId))
        assertEquals(false, cache.gone(theirs, nodeId))
        assertEquals(theirs, cache.live(nodeId, theirs)?.node?.workspaceId)
        assertNull(cache.live(nodeId, own))
        // Both gone, then the share's comes back: only its mark clears.
        cache.remove(theirs, nodeId)
        cache.put(row(theirs), serverKey)
        assertEquals(false, cache.gone(theirs, nodeId))
        assertEquals(true, cache.gone(own, nodeId))
    }
}

