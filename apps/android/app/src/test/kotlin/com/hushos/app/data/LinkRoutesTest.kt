package com.hushos.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A link's token opens its whole tree, and reverse proxies log request paths: every visitor route sends it in the
 * x-link-token header and never in the path or query (docs/integrity-design.md, "Smaller fixes"). Responses carry no
 * signer or signature fields, which a visitor reads as nothing to check, not as a failure.
 */
class LinkRoutesTest {
    private val origin = "https://drive.example"
    private val token = "Tok3n_abcdefghijklmnopqrstuvwxyz0123456789AB"
    private val sent = ArrayList<PublicRequest>()

    private val node = JSONObject().put("id", "8ed4e4f6-a53d-4def-98eb-7b6eb155f6f0").put("workspaceId", "3e0c6aac-0d8c-4577-b886-e9862ef4df13")
        .put("parentId", JSONObject.NULL).put("kind", "folder").put("keyEpoch", 2).put("parentKeyEpoch", 1).put("keyEnvelope", "k")
        .put("metadataVersion", 1).put("metadataEnvelope", "m").put("currentVersion", JSONObject.NULL).put("trashedAt", JSONObject.NULL)

    private fun api(status: Int = 200) = PublicApi(origin) { request ->
        sent.add(request)
        val path = request.url.removePrefix("$origin/api/drive").substringBefore('?')
        status to when {
            status != 200 -> JSONObject().put("message", "Update HushOS to open links.").toString()
            path == "/links/open" -> JSONObject().put("link", JSONObject().put("id", "l").put("workspaceId", node.getString("workspaceId")).put("keyEpoch", 2)
                .put("hasPassword", false).put("linkSalt", "s").put("linkEnvelope", "e").put("expiresAt", JSONObject.NULL).put("kdfVersion", 2)).put("node", node).toString()
            path.endsWith("/children") -> JSONObject().put("folder", node).put("ancestors", JSONArray()).put("children", JSONArray()).put("nextCursor", JSONObject.NULL).toString()
            path.endsWith("/url") -> JSONObject().put("url", "https://store.example/object").toString()
            path == "/links/thumbnails" -> JSONObject().put("urls", JSONArray()).toString()
            else -> JSONObject().toString()
        }
    }

    @Test
    fun everyVisitorRouteSendsTheTokenInTheHeaderAndNeverInTheAddress() {
        val api = api()
        val opened = api.openLink(token)
        api.linkChildren(token, node.getString("id"), "cursor-1")
        api.linkVersionUrl(token, "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d")
        api.linkThumbnailUrl(token, "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d")
        assertEquals(
            listOf("/links/open", "/links/nodes/${node.getString("id")}/children", "/links/versions/9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d/url", "/links/thumbnails"),
            sent.map { it.url.removePrefix("$origin/api/drive").substringBefore('?') },
        )
        for (request in sent) {
            assertEquals(token, request.headers[LINK_TOKEN_HEADER])
            assertFalse("the token must not be in ${request.url}", request.url.contains(token))
            // No session either: a visitor stays anonymous on a signed-in phone.
            assertFalse(request.headers.keys.any { it.equals("Cookie", ignoreCase = true) })
        }
        // A row served without signer fields is a record with no signer, not a broken one.
        assertNull(opened.node.metadataSigner)
        assertNull(opened.node.metadataSignature)
    }

    @Test
    fun theOldPathFormsRefusalIsSaidNotTakenForAnEmptyAnswer() {
        val refused = assertThrows(ApiError::class.java) { api(410).openLink(token) }
        assertEquals(410, refused.status)
        assertTrue(sent.single().headers.containsKey(LINK_TOKEN_HEADER))
    }
}
