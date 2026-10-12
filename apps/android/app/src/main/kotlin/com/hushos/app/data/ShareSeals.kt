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

    companion object {
        private val LOCK = Any()
        const val FILE = "share-seals.json"
        /* A full pass looks every grantee up (to catch keys they replaced): at most daily, unless a re-seal is waiting. */
        const val PASS_INTERVAL_MS = 24 * 60 * 60 * 1000L

        fun of(context: Context) = ShareSeals(File(context.filesDir, FILE))
    }
}

/*
 * Whether a ledger share must be sealed again: anything but suite 3; one this device has no record of; one signed
 * by an identity older than the current one (this account replaced its keys); or one sealed to grantee keys older
 * than the ones served for them now (they replaced theirs). Sealing then goes only to keys their pin vouches for,
 * following a checked succession first.
 */
fun needsReseal(suite: Int, seal: ShareSeals.Seal?, currentKeyVersion: ULong, servedGranteeKeyVersion: ULong?): Boolean {
    if (suite != 3 || seal == null) return true
    if (seal.granterKeyVersion < currentKeyVersion) return true
    val served = servedGranteeKeyVersion ?: return false
    return seal.granteeKeyVersion == null || served > seal.granteeKeyVersion
}
