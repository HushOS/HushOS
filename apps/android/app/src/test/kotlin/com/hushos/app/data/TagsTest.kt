package com.hushos.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The tags registry is one document every client of the workspace writes. A save that rebuilt it from
 * the fields this version knows would erase whatever a newer client keeps there (on the registry, on a
 * tag, beside the memberships) the moment someone tagged a file on this phone.
 */
class TagsTest {
    private val work = "11111111-1111-4111-8111-111111111111"
    private val home = "22222222-2222-4222-8222-222222222222"
    private val fileA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val fileB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    private val document = """
        {"version":2,"order":"manual",
         "tags":[{"id":"$work","name":"Work","colour":"blue","pinned":true},
                 {"id":"$home","name":"Home","colour":"teal","icon":"house"}],
         "items":{"$work":["$fileA"],"$home":["$fileA","$fileB"],"smart:recent":["$fileB"]}}
    """.trimIndent()

    /* What a save writes, as the next device reads it. */
    private fun saved(registry: TagRegistry) = JSONObject(registry.toJson())
    private fun tag(json: JSONObject, id: String) = json.getJSONArray("tags").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.first { it.getString("id") == id } }
    private fun members(json: JSONObject, id: String) = json.getJSONObject("items").getJSONArray(id).let { a -> (0 until a.length()).map { a.getString(it) } }

    @Test
    fun unknownFieldsSurviveAddRenameRemoveAndAssign() {
        val registry = TagRegistry.parse(document)
        val added = registry.add("Taxes", "coral")
        registry.rename(work, "Office")
        registry.assign(fileB, listOf(work, added.id))
        registry.remove(home)
        val json = saved(TagRegistry.parse(registry.toJson()))

        assertEquals("manual", json.getString("order"))
        assertTrue(tag(json, work).getBoolean("pinned"))
        assertEquals(listOf(fileB), members(json, "smart:recent"))
        // The edits themselves.
        assertEquals("Office", tag(json, work).getString("name"))
        assertEquals(listOf(fileA, fileB), members(json, work))
        assertEquals(listOf(fileB), members(json, added.id))
        assertEquals(listOf(work, added.id), (0 until json.getJSONArray("tags").length()).map { json.getJSONArray("tags").getJSONObject(it).getString("id") })
        assertFalse(json.getJSONObject("items").has(home))
        assertEquals(2, json.getInt("version"))
    }

    @Test
    fun aTagKeepsItsOwnUnknownFieldsUntilItIsRemoved() {
        val registry = TagRegistry.parse(document)
        registry.recolour(home, "#00aa88")
        assertEquals("house", tag(saved(registry), home).getString("icon"))
        assertEquals("#00aa88", tag(saved(registry), home).getString("colour"))
        registry.remove(home)
        assertEquals(1, saved(registry).getJSONArray("tags").length())
    }

    @Test
    fun unassigningEmptiesOnlyThatTagAndKeepsTheOthersInOrder() {
        val registry = TagRegistry.parse(document)
        // fileA stays in Home: it keeps its place ahead of fileB rather than moving to the end.
        registry.assign(fileA, listOf(home))
        val json = saved(registry)
        assertFalse(json.getJSONObject("items").has(work))
        assertEquals(listOf(fileA, fileB), members(json, home))
        assertEquals(listOf(fileB), members(json, "smart:recent"))
    }

    @Test
    fun aRegistryFromANewerFormatIsRefusedRatherThanRewritten() {
        assertThrows(AuthFailure::class.java) { TagRegistry.parse(document.replace("\"version\":2", "\"version\":3")) }
    }

    @Test
    fun anEmptyRegistrySavesTheWebsShape() {
        val registry = TagRegistry.empty()
        val tag = registry.add("Work")
        registry.assign(fileA, listOf(tag.id))
        val json = saved(registry)
        assertEquals(setOf("version", "tags", "items"), json.keys().asSequence().toSet())
        assertEquals(listOf(fileA), members(json, tag.id))
    }
}
