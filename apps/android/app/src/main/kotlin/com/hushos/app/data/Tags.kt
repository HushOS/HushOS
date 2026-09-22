package com.hushos.app.data

import com.hushos.core.DocumentContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.documentOpen
import com.hushos.core.documentSeal
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/*
 * Tags: flat sets an item belongs to across folders. The workspace keeps one
 * registry as a sealed document under the workspace key (tags, and which
 * items carry each), so a share's recipient learns nothing of them.
 */
data class Tag(val id: String, val name: String, val colour: String)

class TagRegistry(val tags: MutableList<Tag>, val items: MutableMap<String, MutableList<String>>) {
    companion object {
        val PRESETS = listOf("blue", "ink", "yellow", "teal", "coral")
        fun empty() = TagRegistry(mutableListOf(), mutableMapOf())

        fun parse(json: String): TagRegistry {
            val root = JSONObject(json)
            val tags = root.getJSONArray("tags").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { Tag(it.getString("id"), it.getString("name"), it.getString("colour")) } }
            val items = mutableMapOf<String, MutableList<String>>()
            val raw = root.getJSONObject("items")
            for (key in raw.keys()) items[key] = raw.getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) } }.toMutableList()
            return TagRegistry(tags.toMutableList(), items)
        }
    }

    fun toJson(): String {
        val items = JSONObject()
        for ((k, v) in this.items) items.put(k, JSONArray(v))
        return JSONObject().put("version", 2).put("tags", JSONArray(tags.map { JSONObject().put("id", it.id).put("name", it.name).put("colour", it.colour) })).put("items", items).toString()
    }

    fun tagsOf(nodeId: String): List<Tag> = tags.filter { items[it.id]?.contains(nodeId) == true }
    fun nodesWith(tagId: String): List<String> = items[tagId].orEmpty()

    fun add(name: String): Tag {
        val clean = checkName(name)
        tags.firstOrNull { it.name.equals(clean, ignoreCase = true) }?.let { return it }
        if (tags.size >= 200) throw AuthFailure("A workspace can have at most 200 tags.")
        val tag = Tag(UUID.randomUUID().toString(), clean, PRESETS[tags.size % PRESETS.size])
        tags.add(tag)
        return tag
    }

    fun rename(id: String, name: String) {
        val clean = checkName(name)
        val index = tags.indexOfFirst { it.id == id }
        if (index >= 0) tags[index] = tags[index].copy(name = clean)
    }

    fun recolour(id: String, colour: String) {
        val index = tags.indexOfFirst { it.id == id }
        if (index >= 0) tags[index] = tags[index].copy(colour = colour)
    }

    fun remove(id: String) {
        tags.removeAll { it.id == id }
        items.remove(id)
    }

    fun assign(nodeId: String, tagIds: Collection<String>) {
        if (tagIds.size > 16) throw AuthFailure("An item can carry at most 16 tags.")
        for (tag in tags) {
            val nodes = items.getOrPut(tag.id) { mutableListOf() }
            nodes.remove(nodeId)
            if (tag.id in tagIds) nodes.add(nodeId)
            if (nodes.isEmpty()) items.remove(tag.id)
        }
    }

    private fun checkName(name: String): String {
        val clean = name.trim().replace(Regex("\\s+"), " ")
        if (clean.isEmpty()) throw AuthFailure("Enter a tag name.")
        if (clean.codePointCount(0, clean.length) > 40) throw AuthFailure("Use a tag name of at most 40 characters.")
        return clean
    }
}

private const val TAGS_KIND = "tags"

/* The registry as the workspace holds it, with the version the next write is based on. */
fun Vault.tags(): Pair<TagRegistry, Int> {
    val ws = workspaceId
    // Kept sealed in the mirror, so the registry reads without network too.
    val key = "tags:$ws"
    val document = try {
        api.document(ws, TAGS_KIND).also { fetched ->
            mirror.putDocument(key, org.json.JSONObject().put("envelope", fetched?.first ?: org.json.JSONObject.NULL).put("version", fetched?.second ?: 0).toString())
        }
    } catch (error: Unreachable) {
        val cached = mirror.document(key)?.let { org.json.JSONObject(it) } ?: throw error
        if (cached.isNull("envelope")) null else cached.getString("envelope") to cached.getInt("version")
    } ?: return TagRegistry.empty() to 0
    val json = documentOpen(DocumentContext(ws, TAGS_KIND, document.second.toULong()), workspaceKey(), base64urlDecode(document.first))
    return TagRegistry.parse(json) to document.second
}

/* Seals and writes the registry one version up; a stale base is reloaded and the change reapplied once. */
fun Vault.saveTags(change: (TagRegistry) -> Unit): TagRegistry {
    val ws = workspaceId
    var attempt = 0
    while (true) {
        val (registry, version) = tags()
        change(registry)
        val envelope = documentSeal(DocumentContext(ws, TAGS_KIND, (version + 1).toULong()), workspaceKey(), registry.toJson())
        try {
            api.putDocument(ws, TAGS_KIND, version, base64urlEncode(envelope))
            return registry
        } catch (error: ApiError) {
            if (error.status != 409 || attempt > 0) throw error
            attempt++
        }
    }
}
