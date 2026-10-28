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
}
