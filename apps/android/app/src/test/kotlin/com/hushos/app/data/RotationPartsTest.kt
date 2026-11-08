package com.hushos.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A rotation page past the server's body cap is refused whole with 413, every time, so the rotation never finishes.
 * Parts must each fit, keep every node once and in order (parents come first in the work), and never cut a node.
 */
class RotationPartsTest {
    private val ws = "0b6d4a3e-2c1f-4d5e-8a9b-1c2d3e4f5a6b"

    private fun node(id: Int, size: Int) = JSONObject().put("id", id.toString()).put("pad", "x".repeat(size))
    private fun array(nodes: List<Any>) = JSONArray().apply { nodes.forEach { put(it) } }
    private fun body(nodes: JSONArray) =
        JSONObject().put("workspaceId", ws).put("nodes", nodes).toString().toByteArray(Charsets.UTF_8).size
    private fun ids(parts: List<JSONArray>) =
        parts.map { part -> (0 until part.length()).map { part.getJSONObject(it).getString("id") } }

    @Test
    fun everyPartFitsAndThePartsAreTheBatchInOrder() {
        val sizes = listOf(900, 10, 450, 3000, 1, 1999, 700, 700, 700, 2500, 5)
        val nodes = sizes.mapIndexed { i, size -> node(i, size) }
        val parts = rotationParts(ws, array(nodes), 2048)
        assertEquals(sizes.indices.map { it.toString() }, ids(parts).flatten())
        for (part in parts) {
            assertTrue(part.length() > 0)
            if (part.length() > 1) assertTrue(body(part) <= 2048)
        }
        // Greedy: no part could have taken the next part's first node.
        for (i in 0 until parts.size - 1) {
            val grown = JSONArray(parts[i].toString()).put(parts[i + 1].get(0))
            assertTrue(body(grown) > 2048)
        }
    }

    @Test
    fun aBodyExactlyAtTheLimitIsOneRequestAndOneByteOverIsTwo() {
        val nodes = array(listOf(node(1, 100), node(2, 100)))
        val exact = body(nodes)
        assertEquals(listOf(listOf("1", "2")), ids(rotationParts(ws, nodes, exact)))
        assertEquals(listOf(listOf("1"), listOf("2")), ids(rotationParts(ws, nodes, exact - 1)))
    }

    @Test
    fun aNodeHeavierThanTheLimitGoesAloneAndItsNeighboursStillShare() {
        val nodes = array(listOf(node(1, 10), node(2, 10), node(3, 5000), node(4, 10), node(5, 10)))
        assertEquals(listOf(listOf("1", "2"), listOf("3"), listOf("4", "5")), ids(rotationParts(ws, nodes, 1024)))
    }

    @Test
    fun bytesAreCountedNotCharacters() {
        // 300 two-byte characters: 300 characters, 600 bytes.
        val wide = JSONObject().put("id", "1").put("pad", "é".repeat(300))
        val nodes = array(listOf(wide, JSONObject(wide.toString())))
        val limit = body(nodes) - 1
        assertTrue(JSONObject().put("workspaceId", ws).put("nodes", nodes).toString().length < limit)
        assertEquals(2, rotationParts(ws, nodes, limit).size)
    }

    @Test
    fun aTypicalPageIsOneRequestAndAnEmptyOneNone() {
        val page = array((0 until 200).map { node(it, 2000) })
        assertEquals(1, rotationParts(ws, page).size)
        // A part must fit the server's rotation cap (ROTATION_BODY_BYTES in apps/web/src/lib/body-caps.ts).
        assertTrue(ROTATION_REQUEST_BYTES <= 8 * 1024 * 1024)
        assertTrue(rotationParts(ws, JSONArray()).isEmpty())
    }
}
