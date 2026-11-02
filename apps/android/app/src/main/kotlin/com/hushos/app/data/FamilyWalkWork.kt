package com.hushos.app.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/*
 * The app's vault for the session on screen, if any (DriveViewModel sets it): a WorkManager job in the same process uses
 * it, so the job and the app share one area ledger, one family sync and its turns (a background acceptance and a
 * foreground one never run at once, and the ledger's floor holds between them). A job without it (the app closed) opens a
 * vault of its own; across ledgers the device record's version compare is what holds (FamilyRecords.put).
 */
object LiveVaults {
    @Volatile var app: Vault? = null

    /* The app's vault while it serves `session` and its session hasn't ended. */
    fun of(session: Shared.Session): Vault? = app?.takeIf { vault ->
        !vault.closed && vault.api.session.token == session.token && vault.api.session.userId.equals(session.userId, ignoreCase = true)
    }
}

/*
 * The members' due work after a removal, in the background (docs/groups-mobile-plan.md Android 4, an owner decision: it
 * finishes while the app is closed): every family this account is in synced, and every key change this phone has its
 * own reason to walk (ownReasonToWalk) walked to its end. Periodic while the account is in a family, so a removal made
 * while the app is closed is found and walked; once more, soon, whenever the app finds one due, so a walk the app began
 * and couldn't finish (closed, killed, offline) is finished. No family, folder or file name goes into WorkManager.
 */
object FamilyWalkWork {
    const val TAG = "family-walks"
    private const val PERIODIC = "family-walks-periodic"
    private const val SOON = "family-walks-soon"

    enum class Outcome { DONE, RETRY, SIGNED_OUT }

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /* While the account is in a family: a check every hour or so, whatever the app does. */
    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<FamilyWalkWorker>(1, TimeUnit.HOURS).setConstraints(network).addTag(TAG).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /* A walk is due (found by the app, or one that stopped): run once as soon as there is a network, retried with backoff. */
    fun soon(context: Context) {
        val request = OneTimeWorkRequestBuilder<FamilyWalkWorker>().setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag(TAG).build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.KEEP, request)
    }

    /* In no family any more (left, removed), or signed out: nothing is checked in the background. */
    fun cancel(context: Context) { runCatching { WorkManager.getInstance(context).cancelAllWorkByTag(TAG) } }

    /*
     * One pass (the worker's body): route 2 with every family it no longer lists asked about (a removal wipes), each
     * family it lists synced, and each run this phone has its own reason to walk walked, one folder at a time in the
     * process. RETRY when any walk or sync didn't finish for a reason that may pass (no answer, a stop); SIGNED_OUT
     * when there is no session.
     */
    fun run(context: Context, vault: Vault? = Shared.session(context)?.let { LiveVaults.of(it) ?: Vault.fromShared(context) }): Outcome {
        val session = vault ?: return Outcome.SIGNED_OUT
        val families = session.families
        return try {
            val (listed, _) = families.listReconciling()
            var again = false
            for (summary in listed.filter { it.state == "active" }) {
                val view = when (val state = families.sync(summary)) {
                    is FamilyState.Accepted -> state.view
                    is FamilyState.Failed -> { if (state.words == FamilyWords.NO_ANSWER) again = true; null }
                    else -> null
                }
                for (target in view?.areas.orEmpty().mapNotNull { it.walkTarget() }) {
                    try {
                        families.walk(summary.id, target)
                    } catch (error: NotAuthenticated) {
                        throw error
                    } catch (_: Exception) {
                        again = true
                    }
                }
            }
            if (listed.isEmpty()) cancel(context)
            if (again) Outcome.RETRY else Outcome.DONE
        } catch (_: NotAuthenticated) {
            Outcome.SIGNED_OUT
        } catch (error: Exception) {
            if (FamilySync.unanswered(error)) Outcome.RETRY else Outcome.DONE
        }
    }
}

class FamilyWalkWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        when (FamilyWalkWork.run(applicationContext)) {
            FamilyWalkWork.Outcome.DONE, FamilyWalkWork.Outcome.SIGNED_OUT -> Result.success()
            FamilyWalkWork.Outcome.RETRY -> Result.retry()
        }
    }
}
