package com.hushos.app.data

import kotlin.coroutines.cancellation.CancellationException

/*
 * How an upload or keep job's work ended. A WorkManager stop (Cancel in the app, or the network constraint lost)
 * cancels the worker's coroutine, but the vault's blocking calls never see that: a cancelled upload went on to the end
 * and said "uploaded", or failed and was recorded as a failure after Cancel had already removed its copy. A stop part
 * way is neither: the job says nothing and records nothing, and WorkManager drops or reschedules it.
 *
 * Work that returned is Done, stop or not: the file is on the server. `stopped` then says the stop came too late, and
 * the worker cancels its own job, so a rescheduled run can't upload the same file again.
 */
sealed interface JobEnd<out T> {
    data class Done<T>(val value: T, val stopped: Boolean = false) : JobEnd<T>
    data class Failed(val error: Exception) : JobEnd<Nothing>
    data object Stopped : JobEnd<Nothing>
}

/* Thrown from a progress callback once the job is stopped, so the vault abandons the transfer (and aborts the upload). */
class JobStopped : CancellationException("The transfer was stopped.")

/*
 * Runs a job's work. `checkStop` belongs in every progress callback: it throws once `isStopped` says so. An exception
 * while the job is stopped (the throw itself, or one the stop caused) is Stopped; a value is Done, with `stopped` set
 * if the stop arrived while the last step was already under way.
 */
inline fun <T> stoppable(crossinline isStopped: () -> Boolean, work: (checkStop: () -> Unit) -> T): JobEnd<T> {
    val checkStop = { if (isStopped()) throw JobStopped() }
    return try {
        val value = work(checkStop)
        JobEnd.Done(value, stopped = isStopped())
    } catch (error: Exception) {
        if (error is CancellationException || isStopped()) JobEnd.Stopped else JobEnd.Failed(error)
    }
}
