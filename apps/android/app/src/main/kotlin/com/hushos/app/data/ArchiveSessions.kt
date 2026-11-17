package com.hushos.app.data

import com.hushos.core.ByteRange
import com.hushos.core.Content
import com.hushos.core.EntrySink
import com.hushos.core.FetchException
import com.hushos.core.LocalSource
import com.hushos.core.ObjectSource
import com.hushos.core.RunControl
import com.hushos.core.ToolClock
import com.hushos.core.ZipArchiveSession
import com.hushos.core.toolWatchdogMillis
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlin.coroutines.cancellation.CancellationException

/*
 * Zip archives open in the app (docs/file-tools-design.md, section 1 (a) and section 6): each one
 * a core `ZipArchiveSession`, which holds the listing and, once typed, the password, in memory.
 * Browsing is a viewer, not a run, so it never takes ToolRuns' one-run slot; it keeps the harness's
 * rules all the same. Every call (open, unlock, preview, download) runs on a thread of its own under
 * a fresh RunControl: the watchdog is polled each second, a cancelled coroutine cancels the control,
 * and `finish()` wipes the call's reader (chunks and key) when its thread returns. One call at a
 * time per archive, the next only once the last one's thread has returned: the object source cuts
 * a fetch off by the control of the call that is reading. A sign-out closes every archive
 * (`closeAll`, from AccountStore.wipe), which wipes its password and ends its calls.
 */
class ArchiveSessions {
    private val open = ConcurrentHashMap.newKeySet<OpenArchive>()

    /* Archives open now: none after a sign-out. */
    val count: Int get() = open.size

    /* Sign-out and account removal: every archive's password goes and every call ends. */
    fun closeAll() {
        for (archive in ArrayList(open)) archive.close()
    }

    internal fun add(archive: OpenArchive) = open.add(archive)
    internal fun remove(archive: OpenArchive) = open.remove(archive)

    /*
     * Opens the archive whose object `source` reads and `content` opens, reading its directory under
     * the first call. `current` is where the source looks for the control of the call reading (on its thread).
     */
    suspend fun open(
        source: ObjectSource,
        content: Content,
        current: CallControl = CallControl(),
        watchdogMillis: Long = toolWatchdogMillis().toLong(),
        pollMillis: Long = 1_000,
        clock: ToolClock? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, current, watchdogMillis, pollMillis, clock)
        add(archive)
        try {
            // The content (which carries the key) is the core's from here; nothing in Kotlin keeps it.
            archive.session = archive.call { control -> ZipArchiveSession.open(source, content, control) }
            if (archive.closed) throw CancellationException("Closed.")
            return archive
        } catch (error: Throwable) {
            archive.close()
            throw error
        }
    }

    /*
     * Opens a zip this phone keeps (an offline copy) from that copy, read by range into memory as the
     * core asks: it opens without a connection, and no further plaintext copy is made.
     */
    suspend fun openLocal(
        source: LocalSource,
        watchdogMillis: Long = toolWatchdogMillis().toLong(),
        pollMillis: Long = 1_000,
        clock: ToolClock? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, CallControl(), watchdogMillis, pollMillis, clock)
        add(archive)
        try {
            archive.session = archive.call { control -> ZipArchiveSession.openLocal(source, control) }
            if (archive.closed) throw CancellationException("Closed.")
            return archive
        } catch (error: Throwable) {
            archive.close()
            throw error
        }
    }

    companion object {
        val shared = ArchiveSessions()
    }
}

/* A kept file by range: each read opens it, seeks and reads that much, keeping nothing. */
class FileLocalSource(private val file: java.io.File) : LocalSource {
    private val length = file.length()
    override fun size(): ULong = length.toULong()
    override fun readAt(offset: ULong, length: ULong): ByteArray = try {
        java.io.RandomAccessFile(file, "r").use { raf ->
            val bytes = ByteArray(length.toInt())
            raf.seek(offset.toLong())
            raf.readFully(bytes)
            bytes
        }
    } catch (error: Exception) {
        throw FetchException.Failed(error.message ?: "The kept copy couldn't be read.")
    }
}

/*
 * The control of the call reading, for the object source: per thread, since each call runs on a
 * thread of its own and the core fetches on that thread. An archive and its siblings share one
 * source while their calls run side by side, so a fetch is always cut off by its own call's end,
 * never by another's.
 */
class CallControl {
    private val local = ThreadLocal<RunControl?>()
    fun get(): RunControl? = local.get()
    internal fun set(control: RunControl?) = if (control == null) local.remove() else local.set(control)
}

class OpenArchive internal constructor(
    private val owner: ArchiveSessions,
    private val current: CallControl,
    private val watchdogMillis: Long,
    private val pollMillis: Long,
    private val clock: ToolClock?,
) {
    @Volatile internal var session: ZipArchiveSession? = null
    @Volatile var closed = false
        private set
    private val turn = Mutex()
    /* The call going now, by what ends it: what close calls. */
    private val calls = ConcurrentHashMap.newKeySet<() -> Unit>()

    /* Calls not yet over (their thread still running): none once each has returned. */
    internal val live: Int get() = calls.size

    private fun opened() = session ?: throw CancellationException("Closed.")

    val entries get() = opened().entries()
    val hidden get() = opened().hidden().toInt()
    val unlocked get() = session?.unlocked() == true

    /* Whether `password` opens the archive; tried on entry `index` first (an item whose own password was asked for). */
    suspend fun unlock(password: String, index: UInt? = null): Boolean = call { opened().unlock(password, index, it) }

    /* The entry's bytes for the viewer, at most `limit` declared, checked to the end: kept in memory, never in a file. */
    suspend fun preview(index: UInt, limit: Long): ByteArray = call { opened().preview(index, limit.toULong(), it) }

    /* The entry into `sink`, a MiB at a time, held to its declared size. */
    suspend fun download(index: UInt, sink: EntrySink) = call { opened().download(index, sink, it) }

    /*
     * The same archive again, with the listing and the password this one holds and a reader of its
     * own: a download runs on one so previews never wait behind it. Closed on its own (the caller
     * closes it when its download ends), with this archive, and by a sign-out's closeAll.
     */
    suspend fun sibling(): OpenArchive {
        val parent = opened()
        val child = OpenArchive(owner, current, watchdogMillis, pollMillis, clock)
        child.session = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { parent.sibling() }
        owner.add(child)
        children.add(child)
        child.parent = this
        // Closed meanwhile: the child goes too, and says so.
        if (closed) { child.close(); throw CancellationException("Closed.") }
        return child
    }
    private val children = ConcurrentHashMap.newKeySet<OpenArchive>()
    @Volatile private var parent: OpenArchive? = null

    /* Wipes the password, ends the call going (it fails at its next read) and forgets the archive; its siblings close with it. */
    fun close() {
        closed = true
        for (child in ArrayList(children)) child.close()
        children.clear()
        parent?.children?.remove(this)
        // Copied by iterating, never by size then elements: a call's thread may remove itself meanwhile.
        for (end in ArrayList(calls)) end()
        session?.closeArchive()
        owner.remove(this)
    }

    /*
     * `work` on a thread of its own under a fresh control, once the last call's thread has returned.
     * Throws CancellationException when the coroutine is cancelled or the archive closed, ToolFailed
     * when the watchdog fires, and the core's ArchiveException otherwise.
     */
    internal suspend fun <T> call(work: (RunControl) -> T): T {
        if (closed) throw CancellationException("Closed.")
        val token = Any()
        turn.lock(token)
        var handedOver = false
        try {
            if (closed) throw CancellationException("Closed.")
            val control = RunControl(watchdogMillis.toULong(), clock)
            val outcome = CompletableDeferred<Result<T>>()
            val end = {
                control.cancel()
                outcome.complete(Result.failure(CancellationException("Cancelled.")))
                Unit
            }
            calls.add(end)
            val thread = Thread(null, {
                var result: Result<T>? = null
                current.set(control)
                try {
                    result = runCatching { work(control) }.recoverCatching { error ->
                        when {
                            control.isCancelled() -> throw CancellationException("Cancelled.")
                            control.timedOut() -> throw ToolFailed()
                            else -> throw error
                        }
                    }
                } finally {
                    // The call is over in every sense before anyone hears it is: its control
                    // finished, it is no longer live, and the next call may start.
                    control.finish()
                    calls.remove(end)
                    current.set(null)
                    turn.unlock(token)
                    outcome.complete(result ?: Result.failure(ToolFailed()))
                }
            }, "archive-call", 8L shl 20)
            handedOver = true
            try {
                thread.start()
            } catch (error: Throwable) {
                handedOver = false
                calls.remove(end)
                throw ToolFailed(cause = error)
            }
            val watchdog = Timers.watchdogs.every(pollMillis) {
                if (control.checkWatchdog()) outcome.complete(Result.failure(ToolFailed()))
            }
            try {
                return outcome.await().getOrThrow()
            } catch (error: Throwable) {
                control.cancel()
                throw error
            } finally {
                watchdog.cancel(false)
            }
        } finally {
            if (!handedOver && turn.holdsLock(token)) turn.unlock(token)
        }
    }
}

/*
 * The object store for an open archive: each range fetched through `api` under the control of the
 * call reading (`current`), retried as downloads are, the address renewed when it expires, and cut
 * off as soon as that call ends. Padding a call still owed when it ended goes to the background
 * drains, as a tool run's does. Built from the version's id alone, never the OpenedVersion.
 */
fun archiveSourceOf(
    api: DriveApi,
    versionId: String,
    workspaceId: String,
    current: CallControl,
    online: () -> Boolean = { true },
    metered: () -> Boolean = { false },
    drains: PaddingDrains = PaddingDrains.shared,
): ObjectSource {
    val born = drains.generation
    val url = AtomicReference<String?>(null)
    fun control() = current.get() ?: throw IllegalStateException("No read is under way.")
    fun address(control: RunControl) = api.versionUrl(versionId, workspaceId) { call, request -> Cutoff.whileRunning(control, call, request) }
    val drainOnce: (ByteRange, (RangeCall) -> Unit) -> Unit = { range, watch ->
        val fetch = { api.range(url.get() ?: throw IllegalStateException("No address."), range) { call, request -> watch(call); request() } }
        try {
            fetch()
        } catch (error: ApiError) {
            if (error.status != 403) throw error
            url.set(api.versionUrl(versionId, workspaceId) { call, request -> watch(call); request() })
            fetch()
        }
    }
    return StoreSource({ ranges -> drains.enqueue(ranges, born, metered(), drainOnce) }) { range, _ ->
        val control = control()
        if (url.get() == null) url.set(address(control))
        Resumable.run(
            online = online,
            sleep = { millis -> sleepWhileRunning(control, millis) },
            onExpired = { url.set(address(control)) },
        ) {
            control.check()
            api.range(url.get()!!, range) { call, request -> Cutoff.whileRunning(control, call, request) }
        }
    }
}

/*
 * Opens `item`'s current version as an archive: its directory read and checked, nothing else. A
 * zip kept on this phone opens from the kept copy, offline included.
 */
suspend fun Vault.openArchive(item: Opened, sessions: ArchiveSessions = ArchiveSessions.shared): OpenArchive {
    Offline.localCopy(context, item)?.let { kept -> return sessions.openLocal(FileLocalSource(kept)) }
    val opened = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { openVersion(item) }
    val current = CallControl()
    val source = archiveSourceOf(
        api, opened.versionId, item.node.workspaceId, current,
        online = { Resumable.online(context) },
        metered = { context.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: false },
    )
    return sessions.open(source, opened.content, current)
}
