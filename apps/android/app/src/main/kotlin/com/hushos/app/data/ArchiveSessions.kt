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
    /*
     * The registry's one lock: FamilyCopies.LOCK, which a forget moves its folders' counts under, a proof
     * names a folder a family's under, and a session ends under. Each registry operation checks an
     * archive's scope (ArchiveScope: its session, workspace, node and count) under it and acts in the
     * same step: an archive is admitted (`admit`), a piece checked (`whileStanding`), a forget or a proof
     * recorded and its archives marked revoked (`revoke`), either wholly before an invalidation or wholly
     * after it. Never held across anything slow: no provider write, no core close, no stream opened (HushOS's
     * own documents provider takes its vault lock and then this one, so this one is never held into it).
     */
    private val lock: Any get() = FamilyCopies.LOCK
    /* Added under the lock (`admit`: the check and the add are one step); read and removed without it. */
    private val open = ConcurrentHashMap.newKeySet<OpenArchive>()

    /* Archives open now: none after a sign-out. */
    val count: Int get() = open.size

    /* Sign-out and account removal: every archive's password goes and every call ends, without waiting on any of them. */
    fun closeAll() {
        for (archive in ArrayList(open)) archive.close()
    }

    /*
     * Registers `archive` while its scope stands, checked under the lock invalidations take: a forget or a
     * proof before this is seen here (and refused with its words), one after finds the archive to close.
     */
    internal fun admit(archive: OpenArchive) = synchronized(lock) {
        archive.scopeRefusal()?.let { words -> throw FamilyFailure(words) }
        open.add(archive)
    }
    internal fun remove(archive: OpenArchive) = open.remove(archive)

    /*
     * `body` (a piece written out) while the archive stands: checked under the registry's lock, written
     * under the archive's own (`OpenArchive.writing`), never the registry's, so a provider's write takes as
     * long as it takes without holding up a forget, a sign-out or the screen. An invalidation marks the
     * archive revoked under the registry's lock first: a piece not yet checked is refused, one already being
     * written finishes, and the download's failure deletes its file, that piece with it.
     */
    internal fun <T> whileStanding(archive: OpenArchive, body: () -> T): T = synchronized(archive.writing) {
        synchronized(lock) {
            archive.scopeRefusal()?.let { words -> throw FetchException.Failed(words) }
            if (archive.closed || archive.revoked) throw FetchException.Failed(FamilyWords.OPEN_AGAIN)
        }
        body()
    }

    /*
     * The workspaces `ids` became family folders (route 25's proof), or a family let go of them: recorded,
     * and every archive of `session` open from them marked revoked, in one step under the lock (reentrant:
     * a proof or a forget calls this inside its own, with what it recorded). The caller closes them after,
     * outside it (`finish`). Bound to the session that forgot: an ended session's late forget reaches
     * nothing, never an archive of the session after it. `session` null (tests) reaches every archive. By
     * workspace; by node only an archive with no workspace (a kept copy whose record predates its
     * workspace's): another workspace's id that collides with it is never reached by it.
     */
    internal fun revoke(session: FamilySessionState?, ids: Collection<String>, nodes: Collection<String> = emptyList()): List<OpenArchive> {
        val gone = ids.map { it.lowercase() }.toSet()
        val purged = nodes.map { it.lowercase() }.toSet()
        return synchronized(lock) {
            if (session?.closed == true) return emptyList()
            // A kept zip known only by its node, however late it registers, never serves after this.
            session?.archivePurged?.addAll(purged)
            open.filter { archive ->
                (session == null || archive.scope?.session === session) &&
                    (archive.workspace in gone || (archive.workspace == null && archive.node in purged))
            }.onEach { it.revoked = true }
        }
    }

    /* Closes what `revoke` reached, outside the lock, its screens told; nothing here waits on a write. */
    internal fun finish(closing: List<OpenArchive>, words: String = FamilyWords.OPEN_AGAIN) {
        for (archive in closing) archive.closeFor(words)
    }

    /* `revoke`, then `finish`: their archives close now, idle or not, siblings with them. Its next call says the family's words. */
    fun closeWorkspaces(
        session: FamilySessionState?,
        ids: Collection<String>,
        nodes: Collection<String> = emptyList(),
        words: String = FamilyWords.OPEN_AGAIN,
    ) = finish(revoke(session, ids, nodes), words)

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
        /* What it is held to, taken before its key was (Vault.archiveScope); none in tests. */
        scope: ArchiveScope? = null,
        /* Without a scope (tests): the workspace a forget or proof closes it by. */
        workspace: String? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, current, watchdogMillis, pollMillis, clock)
        archive.stands = stands
        archive.signedIn = signedIn
        archive.place(scope, workspace, null)
        try {
            admit(archive)
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
        scope: ArchiveScope? = null,
        workspace: String? = null,
        /* The node it is a copy of, from its kept record: a purge of that node closes it. */
        node: String? = null,
    ): OpenArchive {
        val archive = OpenArchive(this, CallControl(), watchdogMillis, pollMillis, clock)
        archive.stands = stands
        archive.place(scope, workspace, node)
        try {
            admit(archive)
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

        /*
         * Where the core's close runs: it waits for a call still in it (a piece being written to a slow
         * provider), so never on the thread that closes, which may be the main one. Daemon threads, as
         * many as are waiting, so one stuck write never holds up another archive's key going.
         */
        internal val closer: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newCachedThreadPool { work ->
            Thread(work, "archive-close").apply { isDaemon = true }
        }
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
        // In HushOS's words, never the system's (a path).
        throw FetchException.Failed(ArchiveWords.KEPT_UNREADABLE)
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
    /* Reached by a forget or a proof (`ArchiveSessions.revoke`), under the registry's lock: no piece is written after. */
    @Volatile internal var revoked = false
    /* Held while a piece is written out (`ArchiveSessions.whileStanding`): the archive's own, never the registry's. */
    internal val writing = Any()
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
    /* What it is held to (Vault.archiveScope); null in tests, which hold it to `stands` alone. */
    @Volatile internal var scope: ArchiveScope? = null
        private set
    /* The workspace it was opened from (null for a kept copy whose record predates its workspace's), lowercase. */
    @Volatile internal var workspace: String? = null
        private set
    @Volatile internal var node: String? = null
        private set

    internal fun place(scope: ArchiveScope?, workspace: String?, node: String?) {
        this.scope = scope
        this.workspace = (scope?.workspace ?: workspace)?.lowercase()
        this.node = (scope?.node ?: node)?.lowercase()
    }

    /*
     * Its scope's words once it no longer stands, else the test's `stands`; null while it stands. Read
     * without the lock (the counts are concurrent maps): a call's check never waits on a piece being
     * written. Where the check and the act must be one step, the registry holds the lock around both.
     */
    internal fun scopeRefusal(): String? = scope?.refusal() ?: stands?.invoke()
    /* The screen showing it: told, with the family's words, when a proof or a forget closes it. */
    @Volatile var onFamilyClosed: ((String) -> Unit)? = null

    /* Closed because its workspace was proven a family's or let go of: the screen drops what it shows. */
    internal fun closeFor(words: String) {
        val told = onFamilyClosed
        onFamilyClosed = null
        close()
        told?.invoke(words)
    }
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
    /* False from the close on, whether or not the core has wiped the password yet (it does so in the background). */
    val unlocked get() = !closed && session?.unlocked() == true

    /* Whether `password` opens the archive; tried on entry `index` first (an item whose own password was asked for). */
    suspend fun unlock(password: String, index: UInt? = null): Boolean = call { opened().unlock(password, index, it) }

    /* The entry's bytes for the viewer, at most `limit` declared, checked to the end: kept in memory, never in a file. */
    suspend fun preview(index: UInt, limit: Long): ByteArray = call { opened().preview(index, limit.toULong(), it) }

    /* The entry into `sink`, a MiB at a time, held to its declared size. */
    suspend fun download(index: UInt, sink: EntrySink) = call {
        // Asked of every piece too: a family let go of mid-download writes nothing more.
        val held = object : EntrySink {
            // Checked and written under the registry's lock: a forget, a proof or a sign-out lands before
            // the check (nothing written) or after the write (and the forget's close stops the next).
            override fun write(chunk: ByteArray) = owner.whileStanding(this@OpenArchive) { sink.write(chunk) }
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
        child.place(scope, workspace, node)
        // Known before it exists, so a close or a sign-out meanwhile reaches it; made under
        // NonCancellable, so a cancel while the core makes it can't drop the session unclosed.
        owner.admit(child)
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
        owner.remove(this)
        // The core's close waits for a call still in it (a piece being written): in the background, never here.
        // The calls are cancelled already, so it returns as soon as that piece does, and the key goes then.
        if (held != null) ArchiveSessions.closer.execute { held.closeArchive() }
    }

    /*
     * `work` on a thread of its own under a fresh control, once the last call's thread has returned.
     * Throws CancellationException when the coroutine is cancelled or the archive closed, ToolFailed
     * when the watchdog fires, and the core's ArchiveException otherwise.
     */
    internal suspend fun <T> call(work: (RunControl) -> T): T {
        // The family's words first: an archive a proof or a forget closed says why, not merely that it closed.
        letGoIfFamilyMoved()
        if (closed) throw CancellationException("Closed.")
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

    /*
     * The family's words if it may no longer be shown (its family let go of, its workspace proven a
     * family's), or the plain close's (a sign-out, Back); null while it stands. A screen asks before
     * it shows what it built meanwhile.
     */
    fun refusal(): String? = scopeRefusal() ?: if (closed) FamilyWords.OPEN_AGAIN else null

    /* Closes the archive and throws the family's words once its family folder was let go of. */
    private fun letGoIfFamilyMoved() {
        val words = scopeRefusal() ?: return
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
            // Added under the lock close() takes: either close sees it and ends it, or the archive closed first and
            // nothing starts (no thread, and during the open no session to close yet).
            synchronized(life) {
                if (closed) throw CancellationException("Closed.")
                calls.add(end)
            }
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
        } catch (error: Exception) {
            if (error is kotlin.coroutines.cancellation.CancellationException || error is FetchException) throw error
            // In HushOS's words, never the system's (a host, a path): StoreSource hands the message to the core.
            throw java.io.IOException(Problems.say(error, ArchiveWords.UNREADABLE))
        }
    }
}

/*
 * Opens `item`'s current version as an archive: its directory read and checked, nothing else. A
 * zip kept on this phone opens from the kept copy, offline included.
 */
suspend fun Vault.openArchive(item: Opened, sessions: ArchiveSessions = ArchiveSessions.shared): OpenArchive {
    // A family's file is held to its folder's invalidation count as it was before anything began; any other (a share's,
    // this account's own) to its workspace never being proven a family's since: from then it is served only through the
    // family's ledger, and an archive opened by another way says so at its next call. A proof also closes it at once
    // (noteFamilyWorkspaces, ArchiveSessions.closeWorkspaces), idle or not.
    // Taken before the key is: a forget or a proof from here on is seen by the registry when it admits the archive.
    val scope = archiveScope(item.node.workspaceId, item.id)
    Offline.localCopy(context, item)?.let { kept ->
        // Held to every revocation the session holds, not only those since this tap: a share's folder let go of before
        // (its count moved then) keeps its copy shut, and a family's opens only through its ledger, as openVersion asks.
        if (!keptAdmits(workspace = item.node.workspaceId, node = item.id, viaFamily = true)) throw FamilyFailure(FamilyWords.OPEN_AGAIN)
        return sessions.openLocal(FileLocalSource(kept), scope = scope)
    }
    val opened = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { openVersion(item) }
    val current = CallControl()
    val source = archiveSourceOf(
        api, opened.versionId, item.node.workspaceId, current,
        online = { Resumable.online(context) },
        metered = { context.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: false },
    )
    return sessions.open(source, opened.content, current, signedIn = api.session, scope = scope)
}

/*
 * What an archive is held to (ArchiveSessions' registry), taken under the lock invalidations take and before
 * anything of it is opened: the session of the vault it opens under, its workspace and node, that workspace's
 * invalidation count, and whether it was a family folder then. Every family folder and every other workspace alike:
 * a forget moves a count whether or not route 25 proved the folder yet.
 */
class ArchiveScope internal constructor(
    internal val session: FamilySessionState,
    internal val workspace: String?,
    internal val node: String?,
    private val epoch: Long,
    private val family: Boolean,
    /* This account's own drive: never a family folder, and no family's forget reaches it. */
    private val own: Boolean = false,
) {
    /* Under FamilyCopies.LOCK: null while it stands; the words its screen says once it doesn't. */
    internal fun refusal(): String? {
        if (session.closed) return FamilyWords.OPEN_AGAIN
        if (own) return null
        val ws = workspace ?: return if (node != null && node in session.archivePurged) FamilyWords.OPEN_AGAIN else null
        val now = session.epochs[ws]
        if ((now?.first ?: 0L) != epoch) return now?.second ?: FamilyWords.OPEN_AGAIN
        // Opened by a share or this account's own keys: from a proof on, the folder serves only through the ledger.
        if (!family && session.areas.containsKey(ws)) return FamilyWords.OPEN_AGAIN
        return null
    }
}

/* The scope an archive of `workspace`'s `node` opens under in this vault's session (ArchiveScope). */
fun Vault.archiveScope(workspace: String?, node: String?): ArchiveScope = synchronized(familyCopiesLock) {
    val ws = workspace?.lowercase()
    val own = ws != null && ws == ownWorkspaceId?.lowercase()
    ArchiveScope(familyState, ws, node?.lowercase(), ws?.let { familyEpoch(it) } ?: 0L, ws != null && isFamilyWorkspace(ws), own)
}
