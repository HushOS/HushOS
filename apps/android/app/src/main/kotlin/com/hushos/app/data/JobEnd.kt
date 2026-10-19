package com.hushos.app.data

import kotlin.coroutines.cancellation.CancellationException

/*
 * How an upload or keep job's work ended. A WorkManager stop (Cancel in the app, or the network constraint lost)
 * cancels the worker's coroutine, but the vault's blocking calls never see that: a cancelled upload went on to the end
 * and said "uploaded", or failed and was recorded as a failure after Cancel had already removed its copy. A stop is
 * neither: the job says nothing and records nothing, and WorkManager drops or reschedules it.
 */
sealed interface JobEnd<out T> {
    data class Done<T>(val value: T) : JobEnd<T>
    data class Failed(val error: Exception) : JobEnd<Nothing>
    data object Stopped : JobEnd<Nothing>
}

/* Thrown from a progress callback once the job is stopped, so the vault abandons the transfer (and aborts the upload). */
class JobStopped : CancellationException("The transfer was stopped.")

/*
 * Runs a job's work. `checkStop` belongs in every progress callback: it throws once `isStopped` says so. Whatever the
 * work then ends with (its value, or the exception a stop caused) counts as Stopped while the job is stopped.
 */
inline fun <T> stoppable(crossinline isStopped: () -> Boolean, work: (checkStop: () -> Unit) -> T): JobEnd<T> {
    val checkStop = { if (isStopped()) throw JobStopped() }
    return try {
        val value = work(checkStop)
        if (isStopped()) JobEnd.Stopped else JobEnd.Done(value)
    } catch (error: Exception) {
        if (error is CancellationException || isStopped()) JobEnd.Stopped else JobEnd.Failed(error)
    }
}
