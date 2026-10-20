package com.hushos.app.ui

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean

/*
 * When what this account shares (`/shares/mine`: By me and the rows' who-can-open marks) is
 * asked again. The server leaves trashed items out of it, and a change in the feed can't say it
 * put an item back, so: after every restore (one row, many, a trash's Undo), and after a sync
 * that applied any change in this account's own drive while the answer is in use, once per
 * sync. One load at a time; a request made while a load runs gets one more load after it (the
 * running one may have read the server before the change), however many asked meanwhile. The
 * decisions live here so the tests can reach them; the view model only loads and applies.
 */
class SharingRefresh(private val load: suspend () -> Unit) {
    private val turn = Mutex()
    private val wanted = AtomicBoolean(false)

    /*
     * After a sync: `touched` is what it applied of this account's own drive (null when the
     * server wasn't asked), `restored` that the sync follows a restore, which always counts.
     */
    suspend fun afterSync(touched: Set<String>?, restored: Boolean, inUse: Boolean) {
        if (restored || (inUse && !touched.isNullOrEmpty())) now()
    }

    /* Loads now, or once more after the load under way; returns when a load begun after this call is done. */
    suspend fun now() {
        wanted.set(true)
        // A load that began after this request already answered it: nothing to ask twice.
        turn.withLock { if (wanted.getAndSet(false)) load() }
    }
}
