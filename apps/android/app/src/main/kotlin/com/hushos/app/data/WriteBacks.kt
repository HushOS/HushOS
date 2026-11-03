package com.hushos.app.data

import android.content.Context
import androidx.work.WorkManager
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/*
 * Another app's saves of one document through the Files app, landed newest last. Each save takes its place among the
 * document's saves (`nextOrder`) in the close callback itself, before anything runs on another thread, so two closes
 * back to back keep their order whichever thread gets further first. A save then lands only through `land`: under the
 * document's lock, and only while no newer save of it has landed (the newest landed is kept on disk, per document). A
 * save that finds a newer one landed is superseded: it is not sent, and nothing is lost, since a save is the whole file
 * as the app last wrote it. Saves are not chained to each other: one cancelled, failed for good or still retrying never
 * stops a newer one from landing, and a Retry (TransferQueue.retry) keeps its save's place, so an old save retried after
 * a newer one landed is superseded rather than landing over it.
 *
 * An edit that keeps the contents ("wa", "rw") starts from the newest save not landed yet (`newestPending`: one in flight
 * in this process, or queued) when it is newer than the newest landed; otherwise from the server. Ids and paths only.
 */
object WriteBacks {
    const val CHAIN = "chain:"
    const val ORDER = "order:"
    private const val PREFS = "write-backs"
    /* The save counter: no account data, so it outlives a sign-out and keeps increasing. */
    private const val COUNTER = "write-back-order"

    /* A document's saves: its workspace and node, both ids. */
    fun chainOf(workspaceId: String, nodeId: String): String = "writeback-${workspaceId.lowercase()}-${nodeId.lowercase()}"

    /*
     * A save's place among every save made on this phone: a counter kept on disk and moved with one atomic write before it
     * is handed out, so it only ever increases, across a restart and whatever the clock does.
     */
    @Synchronized fun nextOrder(context: Context): Long {
        val prefs = context.getSharedPreferences(COUNTER, Context.MODE_PRIVATE)
        val next = prefs.getLong("next", 0L) + 1
        check(prefs.edit().putLong("next", next).commit()) { "The save counter couldn't be kept." }
        return next
    }

    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    private fun lockOf(chain: String) = locks.getOrPut(chain) { ReentrantLock() }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* The place of the newest save of the document that landed; 0 when none did (as far as this phone knows). */
    fun landed(context: Context, chain: String): Long = prefs(context).getLong(chain, 0L)

    /*
     * The account is gone from this phone (sign-out, deletion, another account): every document's landed place goes with
     * it, and nothing in flight here is the next account's.
     */
    fun forgetAll(context: Context) {
        prefs(context).edit().clear().commit()
        inFlight.clear()
    }

    /*
     * `body` under the document's lock, when there is one: taken before any lock of the account's or its upload ledger
     * (Reservations), the order every landing (`land`) takes them in, so no two paths ever wait on each other.
     */
    fun <T> underLock(chain: String?, body: () -> T): T = if (chain == null) body() else lockOf(chain).withLock(body)

    class Superseded : Exception("A newer save of this file landed first.")

    /*
     * `send` (the upload) only while no newer save of the document has landed, under the document's lock so a check and a
     * landing never interleave with another save's; then this save's place is kept as the newest landed. Throws
     * Superseded, having sent nothing, when a newer one landed first.
     */
    fun <T> land(context: Context, chain: String, order: Long, send: () -> T): T = lockOf(chain).withLock {
        if (landed(context, chain) > order) throw Superseded()
        val result = send()
        if (landed(context, chain) < order) prefs(context).edit().putLong(chain, order).commit()
        result
    }

    /* A save found landed by other means (an earlier run's completion whose answer was lost): kept as landed, never lowered. */
    fun markLanded(context: Context, chain: String, order: Long) = lockOf(chain).withLock {
        if (landed(context, chain) < order) prefs(context).edit().putLong(chain, order).commit()
    }

    /* Saves closed in this process and not queued or landed yet, by document: each one's place and contents. */
    private val inFlight = ConcurrentHashMap<String, MutableMap<Long, File>>()

    /* In the close callback, right after `nextOrder`: the save's contents count as the document's until it is queued or landed. */
    fun closing(chain: String, order: Long, file: File) { inFlight.getOrPut(chain) { ConcurrentHashMap() }[order] = file }

    /* Queued (its contents now the job's staged copy) or landed or dropped: no longer in flight here. */
    fun settled(chain: String, order: Long) { inFlight[chain]?.remove(order) }

    /*
     * The contents of the newest save of the document that hasn't landed, when it is newer than the newest landed: one in
     * flight in this process, or a queued job's staged copy. Null when the server's version is the newest.
     */
    fun newestPending(context: Context, chain: String): File? {
        val candidates = HashMap<Long, File>()
        inFlight[chain]?.let { candidates.putAll(it) }
        val queued = runCatching { WorkManager.getInstance(context).getWorkInfosByTag(CHAIN + chain).get() }.getOrDefault(emptyList())
        for (info in queued) {
            if (info.state.isFinished) continue
            val order = info.tags.firstOrNull { it.startsWith(ORDER) }?.removePrefix(ORDER)?.toLongOrNull() ?: continue
            val path = info.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:") ?: continue
            candidates[order] = File(path)
        }
        val landed = landed(context, chain)
        return candidates.filterKeys { it > landed }.entries.sortedByDescending { it.key }.map { it.value }.firstOrNull { it.exists() }
    }
}
