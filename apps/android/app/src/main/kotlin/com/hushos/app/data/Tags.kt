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

/*
 * The registry as edited here, over the document as read: `raw` is the opened JSON, kept whole, so a
 * field a newer client writes (beside `tags`, inside a tag, or in `items` under a key that is no tag)
 * survives a save from this one. `tags` and `items` are the parts this version reads and edits; a save
 * writes them over `raw` and leaves the rest as it was.
 */
class TagRegistry(val tags: MutableList<Tag>, val items: MutableMap<String, MutableList<String>>, private val raw: JSONObject = JSONObject()) {
    /* The ids `items` speaks for: the tags as read and any made since. A key in raw `items` outside these is not ours to drop. */
    private val known: MutableSet<String> = tags.mapTo(HashSet()) { it.id }

    companion object {
        val PRESETS = listOf("blue", "ink", "yellow", "teal", "coral")
        /* The presets the web offers for new tags, in its order (apps/web/src/lib/tags.ts OFFERED_COLOURS). */
        val OFFERED = listOf("blue", "ink", "yellow", "teal", "coral")
        fun empty() = TagRegistry(mutableListOf(), mutableMapOf())

        fun parse(json: String): TagRegistry {
            val root = JSONObject(json)
            // As the web's parseRegistry: a version this app doesn't know is a format it can't write back.
            val version = root.opt("version")
            if (version != 1 && version != 2) throw AuthFailure("The tag list was made by a newer app.")
            val tags = root.getJSONArray("tags").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { Tag(it.getString("id"), it.getString("name"), it.getString("colour")) } }
            val items = mutableMapOf<String, MutableList<String>>()
            val raw = root.optJSONObject("items") ?: JSONObject()
            for (tag in tags) raw.optJSONArray(tag.id)?.let { a -> items[tag.id] = (0 until a.length()).map { a.getString(it) }.toMutableList() }
            return TagRegistry(tags.toMutableList(), items, root)
        }
    }

    fun toJson(): String {
        val out = JSONObject(raw.toString())
        val rawTags = HashMap<String, JSONObject>()
        raw.optJSONArray("tags")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { t -> t.optString("id").ifEmpty { null }?.let { rawTags[it] = t } } }
        val tagArray = JSONArray(tags.map { tag ->
            val entry = rawTags[tag.id]?.let { JSONObject(it.toString()) } ?: JSONObject()
            entry.put("id", tag.id).put("name", tag.name).put("colour", tag.colour)
        })
        val items = out.optJSONObject("items") ?: JSONObject()
        for (id in known) items.remove(id)
        for ((k, v) in this.items) if (v.isNotEmpty()) items.put(k, JSONArray(v))
        return out.put("version", 2).put("tags", tagArray).put("items", items).toString()
    }

    fun tagsOf(nodeId: String): List<Tag> = tags.filter { items[it.id]?.contains(nodeId) == true }
    fun nodesWith(tagId: String): List<String> = items[tagId].orEmpty()

    /* A new tag in `colour`, or the next colour the web offers, cycling as the web does. */
    fun add(name: String, colour: String? = null): Tag {
        val clean = checkName(name)
        tags.firstOrNull { it.name.equals(clean, ignoreCase = true) }?.let { return it }
        if (tags.size >= 200) throw AuthFailure("A workspace can have at most 200 tags.")
        val tag = Tag(UUID.randomUUID().toString(), clean, colour ?: OFFERED[tags.size % OFFERED.size])
        tags.add(tag)
        known.add(tag.id)
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
        // A tag the node keeps keeps its place in the list, as on the web; only what changed moves.
        for (tag in tags) {
            val nodes = items.getOrPut(tag.id) { mutableListOf() }
            if (tag.id in tagIds) { if (nodeId !in nodes) nodes.add(nodeId) } else nodes.remove(nodeId)
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
