package com.hushos.app.files

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.PowerManager

/*
 * Nothing tells this phone of a change made elsewhere (the web, another device), so while Files or a picker is likely
 * open the provider polls the feed every INTERVAL_MS, as the app's own lists do while on screen. Not from a thread of
 * its own: once Files holds its listing, Android caches this process and freezes it within seconds (the cached-app
 * freezer), and a frozen thread never runs. A running job keeps the process thawed, so the polls run inside one job,
 * which ends WINDOW_MS after the last listing, when the screen goes off, or when the network does. A chain of short
 * jobs instead waited about a minute between polls (the scheduler batches delayed jobs), and WorkManager may run work
 * in the process without a job, which leaves it to be frozen mid-poll: hence a JobService of its own. The job carries
 * nothing but its id.
 */
object FilesPoll {
    const val INTERVAL_MS = 30_000L
    const val WINDOW_MS = 2 * 60_000L

    /* Fixed, far above the ids WorkManager hands out from 0 up for the transfer jobs. */
    private const val JOB_ID = 0x48_46_50_4C

    /* A listing was asked for: polls run from now. A job already polling reads the new listing's time and runs on. */
    fun start(context: Context) {
        runCatching {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            // Scheduling the same id again would stop the one running.
            if (scheduler.getPendingJob(JOB_ID) != null) return
            scheduler.schedule(
                JobInfo.Builder(JOB_ID, ComponentName(context, FilesPollService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build(),
            )
        }
    }
}

class FilesPollService : JobService() {
    @Volatile private var polling: Thread? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val power = getSystemService(PowerManager::class.java)
        polling = Thread {
            try {
                while (true) {
                    Thread.sleep(FilesPoll.INTERVAL_MS)
                    // Screen off: nobody is looking at Files, and the job would keep the phone awake for nothing.
                    if (power?.isInteractive == false) break
                    if (HushOSDocumentsProvider.current?.pollOnce() != true) break
                }
            } catch (stopped: InterruptedException) {
                return@Thread
            }
            jobFinished(params, false)
        }.apply { start() }
        return true
    }

    /* Stopped by the system (the network went, say): the next listing starts polling again. */
    override fun onStopJob(params: JobParameters): Boolean {
        polling?.interrupt()
        return false
    }
}
