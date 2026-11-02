package com.hushos.app.data

import android.content.Context
import com.hushos.core.GroupPin
import com.hushos.core.PinMerge
import com.hushos.core.SettingsKeyEnvelope
import com.hushos.core.contactGuardOpen
import com.hushos.core.contactGuardSeal
import com.hushos.core.contactGuardSlot
import com.hushos.core.groupPinCheck
import com.hushos.core.mergePin
import com.hushos.core.pinAhead
import org.json.JSONObject
import java.io.File

/*
 * The family guard (docs/optional-verification.md 2.8, "per family"; iOS's FamilyGuard.swift, the web's
 * createIndexedDbFamilyGuard): the latest group pin this phone accepted for each family, kept apart from the settings and
 * the device record. Acceptance takes it as a mark like any pin, so a family that once was here is never taken on first
 * use again, and a chain short of what this phone accepted is a rollback whatever the server answers meanwhile: a
 * `not-member` answer never clears it, and neither does anything else the server says.
 *
 * Beside the contact guard (`noBackupFilesDir/guard/<slot>.families.json`, the same slot), sealed by the core in the
 * same way (`contact_guard_seal`, kind `families`, under a key from the settings key, its envelope kept beside the
 * record), and deleted with the contact guard on every wipe (ContactGuard.deleteAll removes the folder). Every write is
 * one read-merge-write under the contact guard's lock, only while the session it was read for is still stored and no
 * sign-out came since. It only moves up: each write is the core's `merge_pin` against what is stored, so a late write of
 * an older pin changes nothing, and a pin of another history is refused (FamilyGuardConflict), never written over it. A
 * record that is there and doesn't open is unreadable, never "nothing held"; a write that can't be kept is unsaved.
 */
class FamilyGuardConflict : Refused("Nothing was changed", "This family looks different on this device. Nothing was saved.")

/* The settings key the guard is sealed under, given the envelope kept beside it; `create` makes one for a first write. */
typealias FamilyGuardKeys = (kept: SettingsKeyEnvelope?, create: Boolean) -> MarksKey?

class FamilyGuardStore(
    private val folder: File, private val origin: String, private val userId: String, private val keys: FamilyGuardKeys,
    private val signedIn: () -> Boolean = { true },
) {
    private class Sealed(val key: SettingsKeyEnvelope, val record: String)

    val slot: String get() = contactGuardSlot(origin, userId)

    val file: File get() = File(folder, "$slot.families.json")

    private fun sealed(): Sealed? {
        val text = GuardFile.read(file) ?: return null
        return runCatching {
            val json = JSONObject(text)
            check(json.getInt("v") == 1)
            val key = json.getJSONObject("key")
            Sealed(SettingsKeyEnvelope(key.getString("nonce"), key.getString("ciphertext")), json.getString("record"))
        }.getOrElse { throw GuardUnreadable() }
    }

    private fun open(sealed: Sealed, key: MarksKey): MutableMap<String, GroupPin> = runCatching {
        val json = JSONObject(contactGuardOpen(key.key, userId, slot, KIND, sealed.record))
        check(json.getInt("v") == 1)
        val families = json.getJSONObject("families")
        val out = LinkedHashMap<String, GroupPin>()
        // A pin the core would refuse as a settings pin is no pin: the record reads as unreadable.
        for (id in families.keys()) out[id] = groupPinCheck(id, groupPinOf(families.getJSONObject(id)) ?: error("pin"))
        out
    }.getOrElse { throw GuardUnreadable() }

    /* Every family's guard: empty when none is stored; GuardUnreadable when one is there and doesn't open. */
    fun record(): Map<String, GroupPin> {
        val sealed = sealed() ?: return emptyMap()
        val key = runCatching { keys(sealed.key, false) }.getOrNull() ?: throw GuardUnreadable()
        return open(sealed, key)
    }

    /* The guard this phone holds for a family: null for none; GuardUnreadable when it could not be read. */
    fun family(groupId: String): GroupPin? = record()[groupId.lowercase()]

    /*
     * `pin` merged into what is stored for the family (never lower), and what is stored after. Behind what is stored,
     * or adding nothing to it: nothing written. Another history: FamilyGuardConflict, nothing written.
     */
    fun keep(groupId: String, pin: GroupPin): GroupPin {
        val id = groupId.lowercase()
        val began = ContactGuard.GENERATION
        if (!signedIn()) throw GuardUnsaved()
        synchronized(ContactGuard.LOCK) {
            if (!signedIn() || ContactGuard.GENERATION != began) throw GuardUnsaved()
            val held = sealed()
            val record = if (held == null) LinkedHashMap() else open(held, runCatching { keys(held.key, false) }.getOrNull() ?: throw GuardUnreadable())
            val current = record[id]
            val merged = when (val merge = mergePin(id, current, pin, emptyList())) {
                is PinMerge.Conflict -> throw FamilyGuardConflict()
                is PinMerge.Behind -> return current ?: throw GuardUnsaved()
                is PinMerge.Merged -> merge.pin
            }
            if (!pinAhead(current, merged)) return current ?: merged
            record[id] = merged
            val key = runCatching { keys(held?.key, true) }.getOrNull() ?: throw GuardUnsaved()
            try {
                val json = JSONObject().put("v", 1).put("families", JSONObject().also { all -> record.forEach { (family, kept) -> all.put(family, groupPinJson(kept)) } })
                val envelope = contactGuardSeal(key.key, userId, slot, KIND, json.toString())
                val out = JSONObject().put("v", 1).put("key", JSONObject().put("nonce", key.envelope.nonce).put("ciphertext", key.envelope.ciphertext))
                    .put("record", envelope)
                folder.mkdirs()
                val next = File(file.path + ".next")
                next.writeText(out.toString())
                if (!next.renameTo(file)) throw java.io.IOException("not moved")
            } catch (_: Exception) {
                throw GuardUnsaved()
            }
            // Signed out while this wrote: what it wrote goes too.
            if (!signedIn() || ContactGuard.GENERATION != began) { file.delete(); throw GuardUnsaved() }
            return merged
        }
    }

    companion object {
        private const val KIND = "families"

        fun of(context: Context, session: Shared.Session, writable: () -> Boolean = { true }, keys: FamilyGuardKeys) =
            FamilyGuardStore(File(context.noBackupFilesDir, ContactGuard.FOLDER), session.origin, session.userId, keys) { Shared.session(context)?.token == session.token && writable() }
    }
}

/* A group pin as the settings and the guard keep it (the web's GroupPin JSON). */
fun groupPinJson(pin: GroupPin): JSONObject = JSONObject().put("firstEd25519PublicKey", pin.firstEd25519PublicKey)
    .put("firstMlDsaPublicKeyDigest", pin.firstMlDsaPublicKeyDigest).put("checkedAt", pin.checkedAt).put("keyVersion", pin.keyVersion.toLong())
    .put("groupKeyDigest", pin.groupKeyDigest).put("rosterVersion", pin.rosterVersion.toLong()).put("rosterDigest", pin.rosterDigest)
    .put("areas", JSONObject().also { areas -> pin.areas.forEach { (id, version) -> areas.put(id, version.toLong()) } })

/* The pin a JSON object holds, unchecked; null when a field is missing or of the wrong kind. */
fun groupPinOf(json: JSONObject): GroupPin? = runCatching {
    fun version(value: Any?): ULong = (value as? Number)?.toLong()?.takeIf { it >= 0 && (value !is Double && value !is Float || value.toDouble() == it.toDouble()) }?.toULong() ?: error("version")
    val areas = json.getJSONObject("areas")
    GroupPin(json.get("firstEd25519PublicKey") as String, json.get("firstMlDsaPublicKeyDigest") as String, json.get("checkedAt") as String,
        version(json.get("keyVersion")), json.get("groupKeyDigest") as String, version(json.get("rosterVersion")), json.get("rosterDigest") as String,
        areas.keys().asSequence().associateWith { version(areas.get(it)) })
}.getOrNull()
