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

    private const val SESSION = "session"

    /*
     * The session a job belongs to, as a tag, a unique name's suffix and the job's input: a digest of the account and the
     * session token (no name, and nothing the token can be read back from), so one session's pass never cancels or
     * keeps another's work, and a job left over from an ended session does nothing.
     */
    fun sessionKey(session: Shared.Session): String =
        java.security.MessageDigest.getInstance("SHA-256").digest((session.userId.lowercase() + "|" + session.token).toByteArray())
            .take(12).joinToString("") { "%02x".format(it) }

    private fun sessionTag(key: String) = "$TAG:$key"

    /* While the account is in a family: a check every hour or so, whatever the app does. For the session signed in now. */
    fun schedule(context: Context) {
        val key = Shared.session(context)?.let(::sessionKey) ?: return
        val request = PeriodicWorkRequestBuilder<FamilyWalkWorker>(1, TimeUnit.HOURS).setConstraints(network).addTag(TAG).addTag(sessionTag(key))
            .setInputData(androidx.work.workDataOf(SESSION to key)).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("$PERIODIC:$key", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /* A walk is due (found by the app, or one that stopped): run once as soon as there is a network, retried with backoff. */
    fun soon(context: Context) {
        val key = Shared.session(context)?.let(::sessionKey) ?: return
        val request = OneTimeWorkRequestBuilder<FamilyWalkWorker>().setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag(TAG).addTag(sessionTag(key))
            .setInputData(androidx.work.workDataOf(SESSION to key)).build()
        WorkManager.getInstance(context).enqueueUniqueWork("$SOON:$key", ExistingWorkPolicy.KEEP, request)
    }

    /* Signed out, the account wiped: nothing of any session is checked in the background. */
    fun cancel(context: Context) { runCatching { WorkManager.getInstance(context).cancelAllWorkByTag(TAG) } }

    /* In no family any more (left, removed): this session's checks stop, and only this session's. */
    fun cancelSession(context: Context, session: Shared.Session) {
        runCatching { WorkManager.getInstance(context).cancelAllWorkByTag(sessionTag(sessionKey(session))) }
    }

    /* Whether `vault` is still the session signed in on this phone, and still open: nothing else is worked or stopped. */
    fun current(context: Context, vault: Vault): Boolean =
        !vault.closed && Shared.session(context)?.let { sessionKey(it) == sessionKey(vault.api.session) } == true

    /*
     * One pass (the worker's body): route 2 with every family it no longer lists asked about (a removal wipes), each
     * family it lists synced, and each run this phone has its own reason to walk walked, one folder at a time in the
     * process. RETRY when any walk, sync or removal didn't finish for a reason that may pass (no answer, a stop, a family
     * still kept that the server hasn't confirmed this account left); SIGNED_OUT when there is no session.
     */
    fun run(
        context: Context,
        vault: Vault? = Shared.session(context)?.let { LiveVaults.of(it) ?: Vault.fromShared(context) },
        /* What lets the background check go: only this vault's session's work (tests watch it). */
        stop: () -> Unit = { vault?.let { cancelSession(context, it.api.session) } },
    ): Outcome {
        val session = vault ?: return Outcome.SIGNED_OUT
        // Every step only while this vault is the open session signed in now: a pass whose session ended (a sign-out,
        // another account) does nothing more, and never touches the next session's work.
        if (!current(context, session)) return Outcome.SIGNED_OUT
        val families = session.families
        return try {
            val (listed, gone) = families.listReconciling()
            if (!current(context, session)) return Outcome.SIGNED_OUT
            // A removal not settled (no answer to route 5, or a wipe that couldn't finish) is asked about again: its record
            // and copies stay until the server's not-member lets them go.
            val unsettled = families.unsettled(listed)
            var again = unsettled.isNotEmpty() || gone.any { it.state != FamilyState.Wiped }
            for (summary in listed.filter { it.state == "active" }) {
                if (!current(context, session)) return Outcome.SIGNED_OUT
                val view = when (val state = families.sync(summary)) {
                    is FamilyState.Accepted -> state.view
                    // No answer, a timeout, throttling or a server error: the family is checked again with backoff.
                    // A removal whose wipe didn't finish is asked about again too, until it does.
                    is FamilyState.Failed -> { if (state.transient || state.removal || state.words == FamilyWords.NO_ANSWER) again = true; null }
                    else -> null
                }
                for (target in view?.areas.orEmpty().mapNotNull { it.walkTarget() }) {
                    if (!current(context, session)) return Outcome.SIGNED_OUT
                    try {
                        families.walk(summary.id, target)
                    } catch (error: NotAuthenticated) {
                        throw error
                    } catch (_: Exception) {
                        again = true
                    }
                }
            }
            // Nothing left to check only once no family is listed and none is kept on this phone.
            // Reached only while the session still stands: the pass returned at the first check after it ended.
            if (listed.isEmpty() && unsettled.isEmpty() && !again) stop()
            if (again) Outcome.RETRY else Outcome.DONE
        } catch (_: NotAuthenticated) {
            Outcome.SIGNED_OUT
        } catch (error: Exception) {
            if (FamilySync.transient(error)) Outcome.RETRY else Outcome.DONE
        }
    }
}

class FamilyWalkWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // A job left over from a session that ended does nothing for the one signed in now.
        val now = Shared.session(applicationContext)?.let(FamilyWalkWork::sessionKey)
        if (now == null || now != inputData.getString("session")) return@withContext Result.success()
        when (FamilyWalkWork.run(applicationContext)) {
            FamilyWalkWork.Outcome.DONE, FamilyWalkWork.Outcome.SIGNED_OUT -> Result.success()
            FamilyWalkWork.Outcome.RETRY -> Result.retry()
        }
    }
}
