package com.hushos.app.data

import android.content.Context
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/*
 * Another app's saves of one document through the Files app, kept in the order they were made. Each document has one
 * chain of queued write-backs (a WorkManager unique work, appended to: a save queued behind another runs only once that
 * one ended, and never before it), saves of it are handled one at a time in this process (`serially`), and none goes
 * straight to the server while an earlier one is still queued. An edit that keeps the contents ("wa", "rw") starts from
 * the newest save still queued (`pending`), never from the server's older version, which the queued save would then
 * replace with the edit dropped. Ids and paths only: no file or folder name.
 */
object WriteBacks {
    private const val CHAIN = "chain:"
    private const val ORDER = "order:"

    /* The chain of a document's write-backs: its workspace and node, both ids. */
    fun chainOf(workspaceId: String, nodeId: String): String = "writeback-${workspaceId.lowercase()}-${nodeId.lowercase()}"

    private val locks = ConcurrentHashMap<String, Any>()

    /* `body` while no other save or contents-keeping open of the document runs in this process. */
    inline fun <T> serially(chain: String, body: () -> T): T = synchronized(lockOf(chain)) { body() }

    @PublishedApi internal fun lockOf(chain: String): Any = locks.getOrPut(chain) { Any() }

    private var last = 0L

    /* Increasing across the process's saves, so the newest queued save of a chain is the one with the highest. */
    @Synchronized fun nextOrder(): Long = maxOf(System.currentTimeMillis() * 1000, last + 1).also { last = it }

    /* The tags a queued write-back carries: its chain, and its place in it. */
    fun tags(chain: String, order: Long): List<String> = listOf(CHAIN + chain, ORDER + order)

    private fun queued(context: Context, chain: String): List<WorkInfo> =
        runCatching { WorkManager.getInstance(context).getWorkInfosForUniqueWork(chain).get() }.getOrDefault(emptyList()).filter { !it.state.isFinished }

    /* Whether a save of the document is still queued (waiting, retrying or running). */
    fun anyPending(context: Context, chain: String): Boolean = queued(context, chain).isNotEmpty()

    /* The newest save of the document still queued: its staged contents, where the job reads them from. Null when none is. */
    fun pending(context: Context, chain: String): File? {
        val newest = queued(context, chain).maxByOrNull { info -> info.tags.firstOrNull { it.startsWith(ORDER) }?.removePrefix(ORDER)?.toLongOrNull() ?: 0L } ?: return null
        val path = newest.tags.firstOrNull { it.startsWith("file:") }?.removePrefix("file:") ?: return null
        return File(path).takeIf { it.exists() }
    }
}
