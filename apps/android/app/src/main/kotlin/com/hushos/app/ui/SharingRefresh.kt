package com.hushos.app.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean

/*
 * When what this account shares (`/shares/mine`: By me and the rows' who-can-open marks) is
 * asked again. The server leaves trashed items out of it, and a change in the feed can't say it
 * put an item back, so: after every restore (one row, many, a trash's Undo), at once, and after
 * a sync that applied any change in this account's own drive. Both apps sync after nearly every
 * write, so that second path is held to one load per `interval` (a 200-photo upload is not 200
 * requests): a change inside the interval waits for one load at its end (launched in `scope`).
 * One load at a time; a request made while a load runs gets one more load after it (the running
 * one may have read the server before the change), however many asked meanwhile, and any load
 * that begins answers every change waiting for the interval to end. The decisions live here so
 * the tests can reach them; the view model only loads and applies.
 */
class SharingRefresh(
    private val scope: CoroutineScope,
    private val interval: Long = 10_000,
    /* Milliseconds on a clock that only goes forward. */
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wait: suspend (Long) -> Unit = { delay(it) },
    private val load: suspend () -> Unit,
) {
    private val turn = Mutex()
    private val wanted = AtomicBoolean(false)
    private val books = Any()
    private var lastBegan: Long? = null
    private var waiting: Job? = null

    /* The load a change inside the interval waits for; internal so the tests can wait for it. */
    internal val trailing: Job? get() = synchronized(books) { waiting }

    /*
     * After a sync: `touched` is what it applied of this account's own drive (null when the
     * server wasn't asked), `restored` that the sync follows a restore, which always loads now.
     */
    suspend fun afterSync(touched: Set<String>?, restored: Boolean) {
        if (restored) return now()
        if (touched.isNullOrEmpty()) return
        var start: Job? = null
        val loadNow = synchronized(books) {
            val since = lastBegan?.let { clock() - it } ?: Long.MAX_VALUE
            if (since < interval) {
                // Inside the interval: one load at its end, for this change and any that follow it. Made lazy and
                // recorded before it starts: on an immediate dispatcher its body runs inside `start()`, and a body
                // that ran before the record would leave a finished job blocking every later one, or be taken
                // for the waiting load and cancelled by its own `now()`.
                if (waiting == null) {
                    lateinit var job: Job
                    job = scope.launch(start = CoroutineStart.LAZY) {
                        // Measured when the wait starts, so a late start never pushes the load past the interval's end.
                        wait(maxOf(0L, synchronized(books) { (lastBegan ?: 0L) + interval } - clock()))
                        synchronized(books) { if (waiting === job) waiting = null }
                        now()
                    }
                    waiting = job
                    start = job
                }
                false
            } else true
        }
        // Outside the lock: an immediate dispatcher runs the body here.
        start?.start()
        if (loadNow) now()
    }

    /* Loads now, or once more after the load under way; returns when a load begun after this call is done. */
    suspend fun now() {
        wanted.set(true)
        // A load that began after this request already answered it: nothing to ask twice.
        turn.withLock {
            if (!wanted.getAndSet(false)) return
            // Begun after every change asked so far: the one waiting for the interval is answered too.
            synchronized(books) {
                waiting?.cancel()
                waiting = null
                lastBegan = clock()
            }
            load()
        }
    }

    companion object {
        /*
         * What By me lists, as the server answered: each share with its role, each link, by id. By me
         * reads its list again whenever this changes, even when the rows' marks stay the same (a link
         * replaced by another, an expired link turned off, a second Sam).
         */
        fun listing(shares: List<Pair<String, String>>, links: List<String>): Set<String> =
            shares.map { (id, role) -> "share $id $role" }.toSet() + links.map { "link $it" }
    }
}
