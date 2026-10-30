package com.hushos.app.data

import android.content.Context
import org.json.JSONObject
import java.io.File

/*
 * What this device last sealed each of the account's shares with: its own identity's key version and the
 * grantee's. The server keeps neither (a share row says only its suite), so this is how the re-seal pass
 * knows a share still signed by a replaced identity, or sealed to keys its grantee has since replaced. A
 * share this device has no record of (made elsewhere, or before this was kept) is sealed again once, which
 * costs a request and loses nothing. `pending` names an identity whose re-seal has not finished: the next
 * Drive open finishes it rather than waiting for the daily pass. Account data: a sign-out removes it.
 */
class ShareSeals(private val file: File) {
    data class Seal(val granterKeyVersion: ULong, val granteeKeyVersion: ULong?)

    private fun read(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        val next = File(file.path + ".next")
        next.writeText(json.toString())
        if (!next.renameTo(file)) { file.writeText(json.toString()); next.delete() }
    }

    private fun shares(json: JSONObject): JSONObject = json.optJSONObject("shares") ?: JSONObject().also { json.put("shares", it) }

    fun get(shareId: String): Seal? = synchronized(LOCK) {
        read().optJSONObject("shares")?.optJSONObject(shareId)?.let { seal ->
            val granter = seal.optLong("granter", 0L).takeIf { it >= 1 } ?: return@let null
            Seal(granter.toULong(), seal.optLong("grantee", 0L).takeIf { it >= 1 }?.toULong())
        }
    }

    fun record(seals: Map<String, Seal>) = synchronized(LOCK) {
        if (seals.isEmpty()) return@synchronized
        val json = read()
        val all = shares(json)
        for ((id, seal) in seals) all.put(id, JSONObject().put("granter", seal.granterKeyVersion.toLong()).put("grantee", seal.granteeKeyVersion?.toLong() ?: JSONObject.NULL))
        write(json)
    }

    /* An identity whose shares must still be sealed again; null when none is waiting. */
    var pending: ULong?
        get() = synchronized(LOCK) { read().optLong("pending", 0L).takeIf { it >= 1 }?.toULong() }
        set(value) = synchronized(LOCK) { val json = read(); if (value == null) json.remove("pending") else json.put("pending", value.toLong()); write(json) }

    /* When the last full pass finished, in epoch milliseconds. */
    var lastPass: Long
        get() = synchronized(LOCK) { read().optLong("lastPass", 0L) }
        set(value) = synchronized(LOCK) { write(read().put("lastPass", value)) }

    /*
     * People whose keys this person accepted or followed while what was shared with them still holds the old keys (a
     * Continue, They match over new keys, a followed succession, `resealShares`): the next pass seals everything shared
     * with them again to the pin's keys, then lets them go. Queued before the save that owes it, so no stop between the
     * two leaves it owed and unqueued; queued twice is only a re-seal done again.
     */
    /*
     * Each request carries the generation it was made at, so a pass acknowledges only what it read before it began: one
     * queued again meanwhile (another Continue, to keys that pass never saw) outlives that pass.
     */
    fun queue(userId: String) = synchronized(LOCK) {
        val json = read()
        val next = json.optLong("toNext", 0L) + 1
        json.put("toNext", next).put("to", requests(json).also { it.put(userId.lowercase(), next) })
        write(json)
    }

    /* Who is owed a re-seal, by lowercased id, with the generation of the latest request. */
    val queued: Map<String, Long> get() = synchronized(LOCK) { requests(read()).let { r -> r.keys().asSequence().associateWith { r.optLong(it) } } }

    /* Acknowledges the requests a pass read (`done`): one made again since, at a later generation, stays. */
    fun unqueue(done: Map<String, Long>) = synchronized(LOCK) {
        if (done.isEmpty()) return@synchronized
        val json = read()
        val requests = requests(json)
        for ((id, generation) in done) if (requests.has(id) && requests.optLong(id) == generation) requests.remove(id)
        if (requests.length() == 0) json.remove("to") else json.put("to", requests)
        write(json)
    }

    /* The requests as stored; the list an earlier build kept reads as generation 0, which any later request is above. */
    private fun requests(json: JSONObject): JSONObject {
        json.optJSONObject("to")?.let { return it }
        val list = json.optJSONArray("to") ?: return JSONObject()
        return JSONObject().also { r -> for (i in 0 until list.length()) list.optString(i).ifEmpty { null }?.let { r.put(it.lowercase(), 0L) } }
    }

    companion object {
        private val LOCK = Any()
        const val FILE = "share-seals.json"
        /* A full pass upgrades older suites and finishes what a key change left: at most daily, unless a re-seal is waiting. */
        const val PASS_INTERVAL_MS = 24 * 60 * 60 * 1000L

        fun of(context: Context) = ShareSeals(File(context.filesDir, FILE))
    }
}

/* The only share suite written and opened: hybrid sealing, signed with Ed25519 and ML-DSA-65. */
const val SHARE_SUITE = 4

/*
 * Whether a ledger share must be sealed again: anything but suite 4 (docs/identity-pq-design.md 3); one this device has no record of; one signed
 * by an identity older than the current one (this account replaced its keys); or one sealed to grantee keys older
 * than the ones their pin holds now (they replaced theirs, and the person checked them again, which moved the pin).
 * Served keys alone never trigger it: a pin follows a succession only when the person asks.
 */
fun needsReseal(suite: Int, seal: ShareSeals.Seal?, currentKeyVersion: ULong, pinnedGranteeKeyVersion: ULong?): Boolean {
    if (suite != SHARE_SUITE || seal == null) return true
    if (seal.granterKeyVersion < currentKeyVersion) return true
    val pinned = pinnedGranteeKeyVersion ?: return false
    return seal.granteeKeyVersion == null || pinned > seal.granteeKeyVersion
}
