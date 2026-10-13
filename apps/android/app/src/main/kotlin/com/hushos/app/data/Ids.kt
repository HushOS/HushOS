package com.hushos.app.data

import com.hushos.core.IdKind
import com.hushos.core.newId
import org.json.JSONObject

/*
 * Ids derived from a seed and a scope (docs/integrity-design.md, "Ids derived from a seed and a scope"): this app never
 * names an id directly. It draws a seed, the core derives the id from it, the kind and the workspace the item is
 * created in (for a report, the workspace of the reported item), and every create sends the seed beside the id. The
 * server derives it again and refuses a mismatch, so an id made here cannot be used to ask about another workspace's.
 *
 * Each kind knows the fields it travels in, so a minted id cannot be sent under another kind's name or without its
 * seed. A retry of a create that already reached the server must send the same pair; nothing here persists an id
 * across attempts (an upload that stops starts over with new ids, as the web's does), so every attempt mints both.
 */
enum class IdField(val kind: IdKind, val idField: String, val seedField: String) {
    /* A node: the root, a folder, a new file's upload, a copy. */
    NODE(IdKind.NODE, "id", "idSeed"),
    VERSION(IdKind.VERSION, "versionId", "versionIdSeed"),
    OBJECT(IdKind.OBJECT, "objectId", "objectIdSeed"),
    LINK(IdKind.LINK, "linkId", "linkIdSeed"),
    REPORT(IdKind.REPORT, "id", "reportIdSeed");

    /* A fresh id of this kind for `scopeId`, and the seed it came from. */
    fun mint(scopeId: String): ScopedId = newId(kind, scopeId).let { ScopedId(this, it.id, it.seed) }
}

/* An id this device made, the seed it was derived from (base64url, 16 bytes), and the fields both are sent in. */
data class ScopedId(val field: IdField, val id: String, val seed: String)

/* Puts the id and its seed side by side, under the field names of its kind. */
fun JSONObject.putId(made: ScopedId): JSONObject = put(made.field.idField, made.id).put(made.field.seedField, made.seed)
