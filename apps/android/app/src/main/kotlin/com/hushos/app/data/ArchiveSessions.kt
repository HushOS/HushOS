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
import kotlinx.coroutines.isActive
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

    /* Tests only: heard on the call's thread once a session is made and handed to its archive, before the caller hears. */
    @Volatile internal var made: ((ZipArchiveSession) -> Unit)? = null

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
        stands: (() -> String?)? = null,
        /* The session the store's reads go under: a 401 names it (ArchiveSessionRefused). */
        signedIn: Shared.Session? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, current, watchdogMillis, pollMillis, clock)
        archive.stands = stands
        archive.signedIn = signedIn
        add(archive)
        try {
            // The content (which carries the key) is the core's from here; nothing in Kotlin keeps it.
            // Handed to the archive on the call's thread, so a result its caller never hears (a
            // cancel, a sign-out, the watchdog) is still closed with the archive.
            archive.call { control -> archive.adopt(ZipArchiveSession.open(source, content, control)) }
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
        stands: (() -> String?)? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, CallControl(), watchdogMillis, pollMillis, clock)
        archive.stands = stands
        add(archive)
        try {
            archive.call { control -> archive.adopt(ZipArchiveSession.openLocal(source, control)) }
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
    /* A 401 a read met on the call's thread: the core carries only a reason across, so it is kept here. */
    private val refused = ThreadLocal<NotAuthenticated?>()
    fun get(): RunControl? = local.get()
    internal fun set(control: RunControl?) {
        if (control == null) local.remove() else local.set(control)
        refused.remove()
    }
    internal fun refuse(error: NotAuthenticated) = refused.set(error)
    internal fun refusedHere(): Boolean = refused.get() != null
}

/*
 * A 401 under an archive's reads, said as itself rather than as the core's failure, with the
 * session the archive reads under: the app ends that session only if it is still the one in use
 * (a late answer for a session gone ends nothing).
 */
class ArchiveSessionRefused(val session: Shared.Session?) : Exception("Your session ended. Sign in again.")

class OpenArchive internal constructor(
    private val owner: ArchiveSessions,
    private val current: CallControl,
    private val watchdogMillis: Long,
    private val pollMillis: Long,
    private val clock: ToolClock?,
) {
    @Volatile internal var session: ZipArchiveSession? = null
        private set
    @Volatile var closed = false
        private set
    /* The session and `closed` change together: a session handed over after the close is closed at once. */
    private val life = Any()

    /*
     * Takes the session the core made, on the call's thread: kept if the archive is open, closed at
     * once (its key wiped) if not, so no session outlives an archive whose caller stopped waiting.
     */
    internal fun adopt(made: ZipArchiveSession) {
        val kept = synchronized(life) { if (closed) false else { session = made; true } }
        if (!kept) made.closeArchive()
        owner.made?.invoke(made)
    }
    /*
     * For a family's file: null while its family folder stands, the family's words once it was let
     * go of (its invalidation count moved: a removal, a fork, a forget). Every call asks before it
     * starts and before it hands anything back, and the archive closes at the first words.
     */
    @Volatile internal var stands: (() -> String?)? = null
    /* The session the store's reads go under, named by a 401 (ArchiveSessionRefused). */
    @Volatile internal var signedIn: Shared.Session? = null
    private val turn = Mutex()
    /* The call going now, by what ends it: what close calls. */
    private val calls = ConcurrentHashMap.newKeySet<() -> Unit>()

    /* Calls not yet over (their thread still running): none once each has returned. */
    internal val live: Int get() = calls.size

    private fun opened() = session ?: throw CancellationException("Closed.")

    val entries get() = opened().entries()
    /* The list's folders, handed over once: the core keeps none after (ArchiveTree holds them). */
    fun takeFolders() = opened().takeFolders()
    val hidden get() = opened().hidden().toInt()
    val unlocked get() = session?.unlocked() == true

    /* Whether `password` opens the archive; tried on entry `index` first (an item whose own password was asked for). */
    suspend fun unlock(password: String, index: UInt? = null): Boolean = call { opened().unlock(password, index, it) }

    /* The entry's bytes for the viewer, at most `limit` declared, checked to the end: kept in memory, never in a file. */
    suspend fun preview(index: UInt, limit: Long): ByteArray = call { opened().preview(index, limit.toULong(), it) }

    /* The entry into `sink`, a MiB at a time, held to its declared size. */
    suspend fun download(index: UInt, sink: EntrySink) = call {
        // Asked of every piece too: a family let go of mid-download writes nothing more.
        val held = object : EntrySink {
            override fun write(chunk: ByteArray) {
                stands?.invoke()?.let { words -> throw FetchException.Failed(words) }
                sink.write(chunk)
            }
        }
        opened().download(index, held, it)
    }

    /*
     * The same archive again, with the listing and the password this one holds and a reader of its
     * own: a download runs on one so previews never wait behind it. Closed on its own (the caller
     * closes it when its download ends), with this archive, and by a sign-out's closeAll.
     */
    suspend fun sibling(): OpenArchive {
        val parent = opened()
        val child = OpenArchive(owner, current, watchdogMillis, pollMillis, clock)
        child.stands = stands
        child.signedIn = signedIn
        // Known before it exists, so a close or a sign-out meanwhile reaches it; made under
        // NonCancellable, so a cancel while the core makes it can't drop the session unclosed.
        owner.add(child)
        children.add(child)
        child.parent = this
        try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable + kotlinx.coroutines.Dispatchers.IO) {
                child.adopt(parent.sibling())
            }
        } catch (error: Throwable) {
            child.close()
            throw error
        }
        // Closed meanwhile (this archive, a sign-out), or the caller cancelled: the child goes, and says so.
        if (closed || child.closed || !kotlinx.coroutines.currentCoroutineContext().isActive) {
            child.close()
            throw CancellationException("Closed.")
        }
        return child
    }
    private val children = ConcurrentHashMap.newKeySet<OpenArchive>()
    @Volatile private var parent: OpenArchive? = null

    /* Wipes the password, ends the call going (it fails at its next read) and forgets the archive; its siblings close with it. */
    fun close() {
        val held = synchronized(life) {
            closed = true
            session
        }
        for (child in ArrayList(children)) child.close()
        children.clear()
        parent?.children?.remove(this)
        // Copied by iterating, never by size then elements: a call's thread may remove itself meanwhile.
        for (end in ArrayList(calls)) end()
        held?.closeArchive()
        owner.remove(this)
    }

    /*
     * `work` on a thread of its own under a fresh control, once the last call's thread has returned.
     * Throws CancellationException when the coroutine is cancelled or the archive closed, ToolFailed
     * when the watchdog fires, and the core's ArchiveException otherwise.
     */
    internal suspend fun <T> call(work: (RunControl) -> T): T {
        if (closed) throw CancellationException("Closed.")
        letGoIfFamilyMoved()
        val result = try {
            callOnce(work)
        } catch (error: Throwable) {
            // Failed because the family went (a download's piece refused): said as that.
            letGoIfFamilyMoved()
            throw error
        }
        letGoIfFamilyMoved()
        return result
    }

    /* Closes the archive and throws the family's words once its family folder was let go of. */
    private fun letGoIfFamilyMoved() {
        val words = stands?.invoke() ?: return
        close()
        throw FamilyFailure(words)
    }

    private suspend fun <T> callOnce(work: (RunControl) -> T): T {
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
                            // A 401: said as itself, with the session, for the app's session check.
                            current.refusedHere() -> throw ArchiveSessionRefused(signedIn)
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
        try {
            if (url.get() == null) url.set(address(control))
            Resumable.run(
                online = online,
                sleep = { millis -> sleepWhileRunning(control, millis) },
                onExpired = { url.set(address(control)) },
            ) {
                control.check()
                api.range(url.get()!!, range) { call, request -> Cutoff.whileRunning(control, call, request) }
            }
        } catch (error: NotAuthenticated) {
            // Kept for the call, which throws it as itself once the core gives up.
            current.refuse(error)
            throw error
        }
    }
}

/*
 * Opens `item`'s current version as an archive: its directory read and checked, nothing else. A
 * zip kept on this phone opens from the kept copy, offline included.
 */
suspend fun Vault.openArchive(item: Opened, sessions: ArchiveSessions = ArchiveSessions.shared): OpenArchive {
    // A family's file is held to its folder's invalidation count as it was before anything began.
    val workspace = item.node.workspaceId
    val stands = if (isFamilyWorkspace(workspace)) familyEpoch(workspace).let { epoch -> { familyWordsSince(workspace, epoch) } } else null
    Offline.localCopy(context, item)?.let { kept -> return sessions.openLocal(FileLocalSource(kept), stands = stands) }
    val opened = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { openVersion(item) }
    val current = CallControl()
    val source = archiveSourceOf(
        api, opened.versionId, item.node.workspaceId, current,
        online = { Resumable.online(context) },
        metered = { context.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: false },
    )
    return sessions.open(source, opened.content, current, stands = stands, signedIn = api.session)
}
