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
     * key-change refusals (said or raw), the server's 409 `rotating`, a completion refused because a key change reached the
     * file while it went up (KeyChangeConflict), and its 409 `stale` once the upload has waited. Never a landed upload.
     */
    fun waits(error: Throwable, waited: Boolean): Boolean {
        val message = error.message.orEmpty()
        if (error is FamilyFailure || error is com.hushos.core.CoreException) {
            return message == FamilyWords.keyChangeWords(KEY_CHANGE_PENDING) || message == KEY_CHANGE_PENDING ||
                message == OLDER_WORKSPACE_KEY || message == OLDER_FOLDER_KEY
        }
        if (error is KeyChangeConflict) return true
        if (error is ApiError && error.status == 409) return error.code == "rotating" || (error.code == "stale" && waited)
        return false
    }

    /* A removal the family's own words say (route 3's not-member, or a folder let go of as one): its uploads end. */
    fun removed(error: Throwable): Boolean = error is FamilyFailure && error.message == FamilyWords.NOT_IN_FAMILY

    /*
     * The family opened in the job's vault: route 2 lists it and its sync accepts it (a not-member answer wipes it, as
     * the app's sync does, and says so; no answer is the network's, retried), then the folder (when one is given) is listed
     * in the family's workspace so its row opens through the ledger.
     */
    fun open(vault: Vault, groupId: String, workspaceId: String, folderId: String?) {
        val sync = vault.jobFamilies
        val summary = transient { sync.list() }.firstOrNull { it.id.equals(groupId, ignoreCase = true) } ?: run {
            // Not listed: asked about as the app asks (route 5); only not-member is a removal. A family route 2 skipped
            // without a not-member answer is no answer yet: the job runs again later.
            val (_, gone) = transient { sync.listReconciling() }
            if (gone.any { it.groupId.equals(groupId, ignoreCase = true) && it.state == FamilyState.Wiped }) throw FamilyFailure.notInFamily
            // The queued family itself, record or not: a process that died between the family's wipe and the end of its
            // uploads left no record for listReconciling to ask about, and the job would wait for ever.
            if (transient { sync.notMember(groupId) }) throw FamilyFailure.notInFamily
            throw Unreachable()
        }
        when (val state = sync.sync(summary)) {
            is FamilyState.Accepted -> Unit
            FamilyState.Wiped -> throw FamilyFailure.notInFamily
            // No answer, a timeout, throttling or a server error anywhere in the sync (route 2, 5, 6, 25): the network's.
            is FamilyState.Failed -> if (state.transient || state.words == FamilyWords.NO_ANSWER) throw Unreachable() else throw FamilyFailure(state.words)
            else -> throw FamilyFailure(FamilySync.checkWordsOf(state))
        }
        if (!vault.isFamilyWorkspace(workspaceId) || vault.familyOf(workspaceId)?.equals(groupId, ignoreCase = true) != true) {
            throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        }
        folderId?.let { vault.listChildren(it, workspaceId) }
    }

    /*
     * The upload itself, after `open`: a replaced file found again in the family's workspace by its node, never by id alone,
     * and listed afresh on every look (a key change finishing between looks re-keys it; a row held from an earlier look
     * would be refused for good): where this vault last saw it, else the folder it was queued from, else where the feed
     * puts it (another member moved it, and those folders may be gone or in the trash). A new file goes into its folder.
     */
    fun upload(vault: Vault, groupId: String, workspaceId: String, file: File, name: String, mime: String?, folderId: String, replacingId: String?,
               job: String, progress: (Float) -> Unit): Opened {
        open(vault, groupId, workspaceId, folderId.takeIf { replacingId == null })
        val replacing = replacingId?.let { id ->
            val last = vault.item(workspaceId, id)?.node?.parentId
            listedIn(vault, workspaceId, last, id) ?: listedIn(vault, workspaceId, folderId.takeIf { it != last }, id)
                ?: relocated(vault, workspaceId, id) ?: throw NotFound("This item no longer exists.")
        }
        return vault.upload(file, name, mime, folderId, replacing, vault.makeThumbnail(file, mime), job = job, progress = progress)
    }

    /* A folder the server says is gone or in the trash: it holds nothing to look for (never the network's failure). */
    fun folderGone(error: Throwable): Boolean = error is NotFound || (error is ApiError && (error.status == 404 || error.code == "trashed"))

    /* `nodeId` as `folderId`, listed through the ledger now, holds it; null when it doesn't, or the folder is gone or in the trash. */
    private fun listedIn(vault: Vault, workspaceId: String, folderId: String?, nodeId: String): Opened? {
        folderId ?: return null
        val listed = try {
            vault.listChildren(folderId, workspaceId)
        } catch (error: Exception) {
            if (folderGone(error)) return null
            throw error
        }
        return listed.firstOrNull { it.id.equals(nodeId, ignoreCase = true) && it.node.workspaceId.equals(workspaceId, ignoreCase = true) }
    }

    /*
     * A file the folders above no longer list (another member moved it): found by its workspace and node, in the folder
     * the workspace's change feed puts it in now, listed through the ledger. Null when the feed has it nowhere.
     */
    private fun relocated(vault: Vault, workspaceId: String, nodeId: String): Opened? {
        var cursor = 0
        var parent: String? = null
        while (true) {
            val page = vault.api.changes(workspaceId, cursor)
            for (change in page.changes) {
                val node = change.node ?: continue
                if (node.id.equals(nodeId, ignoreCase = true) && node.workspaceId.equals(workspaceId, ignoreCase = true)) parent = node.parentId.takeIf { node.trashedAt == null }
            }
            if (!page.hasMore || page.nextCursor <= cursor) break
            cursor = page.nextCursor
        }
        return listedIn(vault, workspaceId, parent, nodeId)
    }

    /* How long a waiting upload pauses between looks (iOS's and the web's cadence, never growing with the tries). */
    const val PAUSE_MS = 30_000L

    /*
     * `attempt` (the family opened and the file uploaded) until it lands, waiting out a key change in the job itself: a
     * look every PAUSE_MS, the family opened again each time, for GIVE_UP_MS from when the wait began (`since`, kept
     * across runs and process deaths by the caller, `mark` to keep it), then GAVE_UP. Anything else is thrown as it is.
     */
    fun <T> waitingOutKeyChanges(since: () -> Long?, mark: (Long) -> Unit, now: () -> Long, pause: (Long) -> Unit, waiting: () -> Unit, attempt: () -> T): T {
        while (true) {
            try {
                return attempt()
            } catch (error: Exception) {
                val began = since()
                if (!waits(error, waited = began != null)) throw error
                val start = began ?: now().also(mark)
                if (now() - start >= GIVE_UP_MS) throw FamilyFailure(GAVE_UP)
                waiting()
                pause(PAUSE_MS)
            }
        }
    }

    /* A group route's no answer, timeout, throttling or server error: the network's, so the job runs again later. */
    private fun <T> transient(body: () -> T): T = try {
        body()
    } catch (error: GroupsApiError) {
        if (error.status == 0 || error.status == 408 || error.status == 429 || error.status >= 500) throw Unreachable()
        throw error
    }
}
