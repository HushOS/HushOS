package com.hushos.app.data

import java.io.File

/*
 * A queued upload into a family folder, as its transfer job runs it (iOS's FamilyUploads): the job's own vault holds no
 * family, so it accepts the family itself first (Vault.jobFamilies: the same acceptance as the app's, never its sweep of
 * family copies), lists the folder through the ledger in its own workspace, then uploads through the vault's family
 * write path (`writing`, familyTarget, the final gate and the reply gate). Done again on every run: a run after the app or
 * the job was stopped (a WorkManager stop, the process killed) accepts the family again before anything is sealed.
 */
object FamilyUploads {
    /* What a waiting upload's row says (the web's FINISHING_KEY_CHANGE, iOS's KeyChangeWait.finishing). */
    const val FINISHING = "Finishing a key change…"
    /* What one that waited half an hour says (iOS's KeyChangeWait.gaveUp). */
    const val GAVE_UP = "The family folder’s key change hasn’t finished, so this file wasn’t uploaded. Retry later."
    const val GIVE_UP_MS = 30 * 60 * 1000L

    private const val KEY_CHANGE_PENDING = "This folder’s keys changed: the key change has not reached it yet."
    private const val OLDER_WORKSPACE_KEY = "This folder was wrapped under an older workspace key."
    private const val OLDER_FOLDER_KEY = "This item was wrapped under an older folder key."

    /*
     * Whether `error` is a key change not finished yet rather than a failure (iOS's KeyChangeWait.meets): the ledger's
     * key-change refusals (said or raw), the server's 409 `rotating`, and its 409 `stale` once the upload has waited.
     */
    fun waits(error: Throwable, waited: Boolean): Boolean {
        val message = error.message.orEmpty()
        if (error is FamilyFailure || error is com.hushos.core.CoreException) {
            return message == FamilyWords.keyChangeWords(KEY_CHANGE_PENDING) || message == KEY_CHANGE_PENDING ||
                message == OLDER_WORKSPACE_KEY || message == OLDER_FOLDER_KEY
        }
        if (error is ApiError && error.status == 409) return error.code == "rotating" || (error.code == "stale" && waited)
        return false
    }

    /* A removal the family's own words say (route 3's not-member, or a folder let go of as one): its uploads end. */
    fun removed(error: Throwable): Boolean = error is FamilyFailure && error.message == FamilyWords.NOT_IN_FAMILY

    /*
     * The family opened in the job's vault: route 2 lists it and its sync accepts it (a not-member answer wipes it, as
     * the app's sync does, and says so; no answer is the network's, retried), then the folder is listed in the family's
     * workspace so its row opens through the ledger.
     */
    fun open(vault: Vault, groupId: String, workspaceId: String, folderId: String) {
        val sync = vault.jobFamilies
        val summary = sync.list().firstOrNull { it.id.equals(groupId, ignoreCase = true) } ?: run {
            // Not listed: asked about as the app asks (route 5); only not-member is a removal.
            val (_, gone) = sync.listReconciling()
            if (gone.any { it.groupId.equals(groupId, ignoreCase = true) && it.state == FamilyState.Wiped }) throw FamilyFailure.notInFamily
            throw FamilyFailure(FamilyWords.OPEN_AGAIN)
        }
        when (val state = sync.sync(summary)) {
            is FamilyState.Accepted -> Unit
            FamilyState.Wiped -> throw FamilyFailure.notInFamily
            is FamilyState.Failed -> if (state.words == FamilyWords.NO_ANSWER) throw Unreachable() else throw FamilyFailure(state.words)
            else -> throw FamilyFailure(FamilySync.checkWordsOf(state))
        }
        if (!vault.isFamilyWorkspace(workspaceId) || vault.familyOf(workspaceId)?.equals(groupId, ignoreCase = true) != true) {
            throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        }
        vault.listChildren(folderId, workspaceId)
    }

    /* The upload itself, after `open`: a replaced file found again in the family's workspace, never by id alone. */
    fun upload(vault: Vault, groupId: String, workspaceId: String, file: File, name: String, mime: String?, folderId: String, replacingId: String?,
               begun: (String, String) -> Unit, progress: (Float) -> Unit): Opened {
        open(vault, groupId, workspaceId, folderId)
        val replacing = replacingId?.let { vault.item(workspaceId, it) ?: throw NotFound("This item no longer exists.") }
        return vault.upload(file, name, mime, folderId, replacing, vault.makeThumbnail(file, mime), begun = begun, progress = progress)
    }
}

/*
 * The server upload a queued job reserved, kept beside its staged copy (`begun` in the job's folder) while it runs: a run
 * the process died in left it reserved, so the next run aborts it before anything else (its room released at once,
 * never held for a day). Gone once the upload landed or was aborted by the vault.
 */
object QueuedUploads {
    private fun record(dir: File) = File(dir, "begun")

    /* Aborts what an earlier run of this job left reserved, then forgets it. */
    fun abortLeftover(dir: File, abort: (uploadId: String, workspaceId: String) -> Unit) {
        val kept = record(dir)
        val lines = runCatching { kept.readLines() }.getOrNull() ?: return
        if (lines.size >= 2 && lines[0].isNotBlank()) runCatching { abort(lines[0], lines[1]) }
        kept.delete()
    }

    /* `body` with the reservation kept while it runs; gone when the upload returns or fails (the vault aborted it then). */
    fun <T> running(dir: File, body: (begun: (String, String) -> Unit) -> T): T {
        val kept = record(dir)
        val result = try {
            body { uploadId, workspaceId -> runCatching { kept.writeText("$uploadId\n$workspaceId") } }
        } catch (error: Exception) {
            kept.delete()
            throw error
        }
        kept.delete()
        return result
    }
}
