package com.hushos.app.data

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/*
 * Sign-ins and removal wipes, once per process. The app's screen and a file picker's sign-in screen each have a view
 * model of their own, so a guard kept in one of them let the other's sign-in land in the middle of its wipe, and the
 * wipe cleared the session just stored. Here every sign-in moves one generation and holds one lock while it writes;
 * a wipe runs under the same lock and only if no sign-in began since the moment it was decided.
 */
object SessionGuard {
    private val lock = ReentrantLock()
    @Volatile private var generation = 0L

    /* Where sign-ins stand now; a wipe decided at this point passes it to wipeUnlessSignedInSince. */
    fun seen(): Long = generation

    /* A sign-in: waits for a wipe under way, and drops any wipe decided before it began. */
    fun <T> signingIn(block: () -> T): T = lock.withLock {
        generation++
        block()
    }

    /* Runs `wipe` unless a sign-in began after `seen`, in which case it returns null and touches nothing. */
    fun <T> wipeUnlessSignedInSince(seen: Long, wipe: () -> T): T? = lock.withLock {
        if (generation != seen) null else wipe()
    }
}
