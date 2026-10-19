package com.hushos.app.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/*
 * One run of a transfer job at a time, per job id, in this process. A stopped worker's coroutine is cancelled, but its
 * thread can still be inside the vault's blocking upload (completing it, say) when WorkManager starts the rescheduled
 * run. That run found no LandedJobs mark yet, uploaded the staged copy a second time, and the copy could be deleted
 * under it: a duplicate, or a false "The file isn't there any more". The rerun now waits here until the old run's
 * work has returned (withContext only returns once its blocking block has), then looks for the mark.
 */
object JobLocks {
    private class Entry {
        val mutex = Mutex()
        var users = 0
    }

    private val entries = HashMap<String, Entry>()

    suspend fun <T> run(id: String, block: suspend () -> T): T {
        val entry = synchronized(entries) { entries.getOrPut(id) { Entry() }.also { it.users++ } }
        try {
            return entry.mutex.withLock { block() }
        } finally {
            // Dropped once nobody holds or waits for it, so finished jobs leave nothing behind.
            synchronized(entries) { if (--entry.users == 0) entries.remove(id) }
        }
    }
}
