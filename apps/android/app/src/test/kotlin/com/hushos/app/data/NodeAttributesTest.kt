package com.hushos.app.data

import com.hushos.core.CoreException
import com.hushos.core.MetadataContext
import com.hushos.core.NodeMetadata
import com.hushos.core.base64urlDecode
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A node's attributes through the Kotlin bindings, as Vault's writes use them: the web's record with
 * attributes (crates/hushos-core/fixtures/web.json) opens with every key, a rename built the way
 * Vault.rename builds it (the opened record with a new name) keeps them, and a record over the
 * limits is refused rather than trimmed. Fails if the map is lost crossing the bindings, or a
 * re-save drops a key this app doesn't know.
 */
class NodeAttributesTest {
    private val node = WebFixture.json.getJSONObject("node")
    private val attributed = node.getJSONObject("attributed")
    private val key = base64urlDecode(node.getString("nodeKey"))
    private val ctx = attributed.getJSONObject("metadataCtx").let {
        MetadataContext(it.getString("workspaceId"), it.getString("nodeId"), it.getLong("metadataVersion").toULong())
    }
    private val expected = attributed.getJSONObject("metadata").getJSONObject("attributes").let { json ->
        json.keys().asSequence().associateWith { json.getString(it) }
    }

    @Test
    fun theWebsRecordOpensWithEveryAttributeAndARenameKeepsThem() {
        val opened = metadataOpen(ctx, key, base64urlDecode(attributed.getString("metadataEnvelope")))
        assertEquals(3, expected.size)
        assertEquals(expected, opened.attributes)
        assertEquals("Plans", opened.name)
        // As Vault.rename and Vault.copy build the record they seal: the opened one, renamed.
        val next = MetadataContext(ctx.workspaceId, ctx.nodeId, ctx.metadataVersion + 1uL)
        val renamed = metadataOpen(next, key, metadataSeal(next, key, opened.copy(name = "Plans 2")))
        assertEquals("Plans 2", renamed.name)
        assertEquals(expected, renamed.attributes)
    }

    @Test
    fun aRecordOverTheLimitsIsRefusedNotTrimmed() {
        val fresh = randomBytes(32u)
        val bare = NodeMetadata("Plans", null, null, null, emptyMap())
        for (bad in listOf(mapOf("Colour" to "x"), (0..32).associate { "k$it" to "v" }, mapOf("colour" to "x".repeat(4096)))) {
            assertThrows(CoreException::class.java) { metadataSeal(ctx, fresh, bare.copy(attributes = bad)) }
        }
        val most = (0 until 32).associate { "k$it" to "v" }
        assertEquals(most, metadataOpen(ctx, fresh, metadataSeal(ctx, fresh, bare.copy(attributes = most))).attributes)
        assertTrue(metadataOpen(ctx, fresh, metadataSeal(ctx, fresh, bare)).attributes.isEmpty())
    }
}
