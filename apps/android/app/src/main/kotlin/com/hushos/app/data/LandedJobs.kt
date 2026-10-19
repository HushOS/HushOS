package com.hushos.app.data

import android.content.Context
import java.io.File

/*
 * Jobs whose work landed although WorkManager had already stopped them. WorkManager ignores a stopped worker's result:
 * a constraint stop or a system timeout reschedules it, and its rerun would upload the file again (or fail on the taken
 * name). Cancelling the job itself instead ended it CANCELLED, so the panel hid it, and for a keep queued with
 * APPEND_OR_REPLACE it cancelled the run queued behind it too. So the run that landed leaves a mark under its own job
 * id, and a rerun of that id finds it first and ends at once as a success, touching nothing; any other job (the next
 * keep in the chain) has no mark and runs as usual.
 */
class LandedJobs(private val dir: File) {
    /* The work of `id` landed: a rerun of it must do nothing. */
    fun mark(id: String) {
        dir.mkdirs()
        File(dir, id).writeText("")
    }

    /* Whether `id` already landed; the mark is used up, so a later, new run of the same id isn't skipped. */
    fun take(id: String): Boolean = File(dir, id).delete()

    /* Marks nobody will take (a cancelled job is never rerun): gone after a day. */
    fun sweep(now: Long = System.currentTimeMillis()) {
        dir.listFiles()?.filter { now - it.lastModified() > DAY_MS }?.forEach { it.delete() }
    }

    companion object {
        const val DIR = "landed-jobs"
        private const val DAY_MS = 24 * 60 * 60 * 1000L

        fun of(context: Context) = LandedJobs(File(context.filesDir, DIR))
    }
}
