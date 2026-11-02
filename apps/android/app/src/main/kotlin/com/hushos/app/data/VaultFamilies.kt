package com.hushos.app.data

import com.hushos.core.FamilyGuard
import com.hushos.core.FamilyChecked
import com.hushos.core.GroupPin
import com.hushos.core.IdentityEnvelope
import com.hushos.core.OwnIdentities
import com.hushos.core.ServedKeys
import com.hushos.core.ServedNodeKey
import com.hushos.core.Integrity
import com.hushos.core.NodeKeyContext
import com.hushos.core.ServedRecord
import com.hushos.core.base64urlDecode
import com.hushos.core.nodeWrap
import com.hushos.core.randomBytes
import kotlinx.coroutines.asContextElement
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/*
 * The vault's side of families (docs/groups-mobile-plan.md, Android 1; iOS's Vault+Families.swift): the area ledger
 * opened for this account, the settings handed to it, family folder nodes opened through it, the family guard and the
 * write barrier, and every change refused in a family folder (writes there are Android 2).
 */

/* A node's key envelopes as the area ledger takes them: a root's parent is its workspace; the previous ones while a walk runs. */
internal fun servedKey(node: NodeView): ServedNodeKey {
    val raw = runCatching { JSONObject(node.rawJson) }.getOrNull()
    fun long(name: String) = raw?.takeIf { it.has(name) && !it.isNull(name) }?.optLong(name)?.toULong()
    return ServedNodeKey(
        node.id, node.parentId ?: node.workspaceId, node.parentKeyEpoch, node.keyEpoch, base64urlDecode(node.keyEnvelope),
        raw?.takeIf { it.has("prevKeyEnvelope") && !it.isNull("prevKeyEnvelope") }?.optString("prevKeyEnvelope")?.let(::base64urlDecode),
        long("prevKeyEpoch"), long("prevParentKeyEpoch"),
    )
}

/*
 * The ledger opened for this account: its user id and current signing key and the account root, then the account's own
 * workspace, so a family whose member list names it can never lock the drive. Called before every family sync.
 */
/* The account's id as the core's group calls take it: a lowercase UUID (the server's own ids already are). */
internal val Vault.familyUserId: String get() = api.session.userId.lowercase()

internal fun Vault.prepareLedger() {
    val keys = identityKeys()
    areaLedger.openAccount(familyUserId, base64urlDecode(keys.signingPublicKey), unlockAccount())
    val view = loadWorkspace()
    workspaceKeyBytes()?.let { areaLedger.openPersonalWorkspace(view.workspaceId, view.grant?.grant?.workspaceKeyVersion ?: 1uL, it) }
}

/*
 * The settings document handed to the ledger as the server served it: the ledger opens the settings key under the
 * account root and the document under it, and takes the family pins (its marks) from what it opened itself. None
 * stored is "no settings"; a version 1 row (served as none at a later sequence) is legacy, which opens nowhere.
 */
internal fun Vault.useForFamilies(stored: Auth.StoredSettings) {
    val envelope = stored.envelope
    when {
        envelope == null && stored.sequence == 0uL -> areaLedger.useSettingsEnvelope(familyUserId, null, null)
        envelope != null && envelope.version == 2u -> areaLedger.useSettingsEnvelope(familyUserId, stored.key, envelope)
        else -> areaLedger.legacySettings(familyUserId)
    }
}

/* The settings read afresh, handed to the ledger as marks, and this family's pin: null for none, refused when it doesn't read. */
internal fun Vault.familyPin(groupId: String): GroupPin? {
    val (settings, stored) = settingsServed()
    useForFamilies(stored)
    return settings.groupPin(groupId)
}

/*
 * Compare and set: `pin` saved as the family's mark only while the stored one is still `expected` (read again on every
 * attempt). False when it changed meanwhile, and nothing was saved. The first-use marker and the `before` records go in
 * the same save, derived from what each attempt read, with a record of what vouched for this acceptance (7.2).
 */
internal fun Vault.saveGroupPin(groupId: String, expected: GroupPin?, pin: GroupPin, checked: FamilyChecked?, now: String): Boolean {
    class Moved : Exception()
    return try {
        updateSettings { settings ->
            if (settings.groupPin(groupId) != expected) throw Moved()
            settings.markFamilyChecks(now, groupId to checked)
            settings.setGroupPin(groupId, pin)
        }
        true
    } catch (_: Moved) {
        false
    }
}

/* This account's identities as acceptance checks its own entries: those with post-quantum keys, the current one first. */
internal fun Vault.ownIdentities(): OwnIdentities = OwnIdentities(familyUserId, identities(strict = true).mapNotNull { keys ->
    val mlDsa = keys.mlDsaPublicKey ?: return@mapNotNull null
    val kem = keys.kemPublicKey ?: return@mapNotNull null
    ServedKeys(keys.keyVersion, keys.encryptionPublicKey, keys.signingPublicKey, mlDsa, kem)
})

/*
 * This account's identity envelope at `version`, for the ledger to open under the account root (it proves it is this
 * account's own): the one served now, or an earlier one from the history.
 */
internal fun Vault.identityEnvelope(version: ULong): IdentityEnvelope {
    val current = Auth.identity(context, api.session)
    if (current.keyVersion == version) return current
    return Auth.identityHistory(context, api.session).firstOrNull { it.keyVersion == version }
        ?: throw FamilyFailure("This family folder was shared with keys this account no longer has.")
}

/* The account key's version, as the personal workspace's grant names it: what a self-grant names. */
internal fun Vault.accountKeyVersion(): ULong = loadWorkspace().grant?.grant?.keyVersion ?: throw ApiError(404, "No workspace grant")

/* Route 25 named these as family folders of `groupId`: never opened under a key from the personal path, for the session. */
internal fun Vault.noteFamilyWorkspaces(ids: List<String>, groupId: String) {
    val own = ownWorkspaceId?.lowercase()
    // Under the lock a share mount, an open and a write's answer keep their rows under: proven and emptied at once, so
    // nothing kept by another way lands between the two.
    val gone = HashSet<String>()
    synchronized(familyCopiesLock) {
        for (id in ids.map { it.lowercase() }) {
            if (id == own) continue
            // Newly proven a family folder: whatever this phone held of it came some other way (a share mount), never
            // through the family's ledger, and goes.
            if (familyAreas.put(id, groupId.lowercase()) == null) {
                val held = nodes.forgetWorkspace(id)
                gone.addAll(held)
                familyPurged.addAll(purgeShareCopies(id, held))
            }
        }
    }
    forgetParents(gone)
}

/*
 * What this phone kept of a folder before it was proven a family's (a share's): its files kept on this phone, its kept
 * folders, and the plaintext copies opened from it (opened/, the Files app's files/ and edits/, old thumbnails/), none of
 * them under opened/family/<workspace> where a family's clear looks. Under the copies lock, with the proof. The ids.
 */
private fun Vault.purgeShareCopies(workspaceId: String, held: Set<String>): Set<String> {
    val ws = workspaceId.lowercase()
    val folders = Offline.folders(context).filter { it.workspaceId.equals(ws, ignoreCase = true) }
    for (folder in folders) Offline.forgetFolder(context, folder.id)
    // An entry kept before its workspace was recorded counts when this phone held its row there.
    val kept = Offline.entries(context).filter { it.workspaceId?.equals(ws, ignoreCase = true) ?: (it.id in held) }
    for (entry in kept) Offline.forget(context, entry.id)
    val ids = held + folders.map { it.id } + kept.map { it.id }
    // Every copy opened from it as a share, whichever process or session opened it: its workspace's folder, whole.
    ShareCopies.folder(context.cacheDir, ws)?.deleteRecursively()
    // Node ids name folders here only when they are ids (never "family", "..", or a path).
    for (id in ids.filter { FamilyRecords.valid(it) }) {
        for (place in listOf("opened", "files", "edits", "thumbnails")) File(File(context.cacheDir, place), id.lowercase()).deleteRecursively()
        if (id != id.lowercase()) for (place in listOf("opened", "files", "edits", "thumbnails")) File(File(context.cacheDir, place), id).deleteRecursively()
    }
    return ids
}

/* The ids a family's proof purged since the last call: their rows, thumbnails and kept entries leave the screens. */
fun Vault.drainFamilyPurged(): Set<String> {
    val out = familyPurged.toSet()
    familyPurged.removeAll(out)
    return out
}

/*
 * Every write's last word, right before it is sent (DriveApi.beforeWrite), under the lock a family's proof takes (iOS's
 * finalGate): never into a workspace a family whose guard is owed holds, and into a family folder only a write that
 * decided at its entry to write as the family's (familyTarget, under the ledger's keys), still writable now. A write
 * begun on a share's or this account's path (sealed under their keys) into a folder proven a family's since is refused,
 * as is any write that declared nothing.
 */
internal fun Vault.finalWriteGate(workspaceId: String) {
    beforeWriteGate?.invoke(workspaceId)
    synchronized(familyCopiesLock) {
        // A session that ended (a sign-out, another sign-in) writes nothing more, from any of its vaults.
        if (closed) throw SessionEnded()
        if (heldUnderOwedGuard(workspaceId)) throw GuardUnsaved()
        if (!isFamilyWorkspace(workspaceId)) return
        if (WriteIntent.decision(workspaceId) != true) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        // Never sent once its folder was let go of since the write began (a removal, a fork, a refusal meanwhile, in
        // another of the session's vaults too): the family's words, before anything leaves.
        WriteIntent.epoch(workspaceId)?.let { began -> familyWordsSince(workspaceId, began)?.let { throw FamilyFailure(it) } }
        familyTarget(workspaceId)
    }
}

/*
 * What a write decided at its entry for each workspace it writes into (iOS's WriteIntent): the first decision stands,
 * whatever a check run later finds. Carried to the final gate on the write's thread, and across a suspended write's
 * dispatchers (writingSuspend).
 */
internal class WriteEntry {
    private val decided = ConcurrentHashMap<String, Boolean>()
    private val epochs = ConcurrentHashMap<String, Long>()
    fun record(workspaceId: String, family: Boolean, epoch: Long = 0L) {
        if (decided.putIfAbsent(workspaceId.lowercase(), family) == null && family) epochs[workspaceId.lowercase()] = epoch
    }
    fun decision(workspaceId: String): Boolean? = decided[workspaceId.lowercase()]
    fun epoch(workspaceId: String): Long? = epochs[workspaceId.lowercase()]
}

internal object WriteIntent {
    val current = ThreadLocal<WriteEntry?>()
    fun record(workspaceId: String, family: Boolean, epoch: Long = 0L) { current.get()?.record(workspaceId, family, epoch) }
    fun decision(workspaceId: String): Boolean? = current.get()?.decision(workspaceId)
    /* The family folder's invalidation count when the write decided to write as the family's: an answer kept only while it stands. */
    fun epoch(workspaceId: String): Long? = current.get()?.epoch(workspaceId)
}

/* A write's body with its own record of what it decided at entry; a write inside another (a copy's folder) shares it. */
internal fun <T> writing(body: () -> T): T {
    if (WriteIntent.current.get() != null) return body()
    WriteIntent.current.set(WriteEntry())
    try {
        return body()
    } finally {
        WriteIntent.current.remove()
    }
}

/* The same for a write that suspends: its record follows it onto every thread it resumes on. */
internal suspend fun <T> writingSuspend(body: suspend () -> T): T {
    val entry = WriteIntent.current.get() ?: WriteEntry()
    return kotlinx.coroutines.withContext(WriteIntent.current.asContextElement(entry)) { body() }
}

/*
 * Whether a write lands in a family folder, and if so whether it may be written now (iOS's familyTarget): the ledger's
 * `require_writable` (not checked against a committed chain, keys changed, no root seen at the write version: refused
 * in the core's words). A folder proven a family's that the ledger doesn't hold (its family not open in this vault: a
 * job's, the Files app's, or one let go of) takes nothing until the family is opened again; it never falls back to the
 * personal key path. Records the decision for the final gate.
 */
internal fun Vault.familyTarget(workspaceId: String): Boolean {
    heldBarrier(workspaceId)
    if (!isFamilyWorkspace(workspaceId)) {
        WriteIntent.record(workspaceId, false)
        return false
    }
    if (!areaLedger.isArea(workspaceId)) throw FamilyFailure(FamilyWords.OPEN_AGAIN)
    requireGuardKept(workspaceId)
    try {
        areaLedger.requireWritable(workspaceId)
    } catch (refused: com.hushos.core.CoreException) {
        throw FamilyFailure(FamilyWords.keyChangeWords(refused.message.orEmpty()))
    }
    // The folder's invalidation count as the write begins: a removal, a fork or a refusal while it is on its way moves it,
    // and its answer is then never kept (Vault.adopt), as an open begun before a forget keeps nothing.
    WriteIntent.record(workspaceId, true, familyEpoch(workspaceId))
    return true
}

/*
 * The key of a family folder node a write puts something under (its metadata, a version), at the epoch it was opened
 * at: the ledger's writable key only, never one reached through a key a key change replaces.
 */
internal fun Vault.writableKey(item: Opened): ByteArray {
    requireGuardKept(item.node.workspaceId)
    val held = try {
        areaLedger.writableNodeKey(item.node.workspaceId, item.id)
    } catch (refused: com.hushos.core.CoreException) {
        throw FamilyFailure(FamilyWords.keyChangeWords(refused.message.orEmpty()))
    } ?: throw ApiError(500, "Open the containing folder first.")
    if (held.epoch != item.node.keyEpoch) throw Refused("Nothing was changed", "This item changed since it was opened. Refresh and retry.")
    return held.key
}

/*
 * A new node's key and its envelope under `parent`: in a family folder made and wrapped by the ledger (never under a
 * parent key it doesn't hold rooted at the folder's write version); in any other drive under the parent's key as this
 * vault opened it.
 */
internal fun Vault.newNodeKey(id: String, parent: Opened, keyEpoch: ULong, family: Boolean): Pair<ByteArray, ByteArray> {
    val ws = parent.node.workspaceId
    if (family) {
        // The choke point every new family node passes: never a key made under an acceptance whose guard is owed.
        requireGuardKept(ws)
        val made = try {
            // Never while a walk's batch holds keys pending in this folder: its parent's might be one the server refuses.
            FamilyKeyLocks.hold(ws) { areaLedger.newNodeKey(ws, id, parent.id, parent.node.keyEpoch, keyEpoch) }
        } catch (refused: com.hushos.core.CoreException) {
            throw FamilyFailure(FamilyWords.keyChangeWords(refused.message.orEmpty()))
        }
        return made.key to made.keyEnvelope
    }
    val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
    val key = randomBytes(32u)
    return key to nodeWrap(NodeKeyContext(ws, id, parent.id, parent.node.keyEpoch, keyEpoch), parentKey, key)
}

/*
 * The form a family folder record is signed again with (a rename's, a replacement's name): as the family's member list
 * judges it (FamilySync.prior, the core's copy_form), never the personal trust set. A refusal is final; no answer is the
 * network's.
 */
internal fun Vault.familyPrior(record: ServedRecord, workspaceId: String): Integrity = try {
    (familyJudge ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)).prior(record, workspaceId)
} catch (error: Exception) {
    if (error is Unreachable || error is NotAuthenticated) throw error
    throw Refused("Nothing was changed", "HushOS couldn’t check who wrote this, so it wasn’t changed. Try again later.")
}

/*
 * Once per session state: the family folders the device records of this account keep (proven by route 25 in an earlier
 * session), named family folders, so a vault in a process the app hasn't synced in yet never takes them for shares.
 */
internal fun Vault.seedFamilyAreas() {
    if (familyState.seeded) return
    synchronized(familyCopiesLock) {
        if (familyState.seeded) return
        val records = FamilyRecords.of(context)
        val user = api.session.userId.lowercase()
        val own = ownWorkspaceId?.lowercase()
        for (group in runCatching { records.groups(user) }.getOrDefault(emptyList())) {
            val areas = runCatching { records.read(user, group)?.areas }.getOrNull().orEmpty()
            for (id in areas.map { it.lowercase() }) if (id != own) familyAreas.putIfAbsent(id, group.lowercase())
        }
        sweepLegacyOpened()
        familyState.seeded = true
    }
}

/*
 * Copies an earlier release left flat under opened/<node> (a received share's among them, which a proof can't find by
 * workspace): each one this account's own drive doesn't hold (its mirror) goes, being only a copy to download again.
 * Old thumbnails/ copies go whole (nothing writes there now). Under the copies lock, once per session state.
 */
private fun Vault.sweepLegacyOpened() {
    val opened = File(context.cacheDir, "opened")
    val names = opened.list().orEmpty().filter { FamilyRecords.valid(it.lowercase()) }
    if (names.isNotEmpty()) {
        val mirror = runCatching { Mirror.shared(context) }.getOrNull()
        for (name in names) {
            val own = runCatching { mirror?.holds(name) == true }.getOrDefault(false)
            if (!own) File(opened, name).deleteRecursively()
        }
    }
    File(context.cacheDir, "thumbnails").deleteRecursively()
}

/* A share into a family's folder: proven, let go of, or held by a barrier still up. Checked again where it is kept. */
internal fun Vault.shareIntoFamily(workspaceId: String): Boolean {
    val id = workspaceId.lowercase()
    return isFamilyWorkspace(id) || familyEpochs.containsKey(id) || heldUnderOwedGuard(id)
}

/*
 * Held for the write barrier (a roster's word, familyHeld): never a family folder by it, and held for every family that
 * named it. Only route 25 with the id check (noteFamilyWorkspaces) makes a workspace a family folder.
 */
internal fun Vault.holdAsFamilyWorkspaces(ids: Collection<String>, groupId: String) {
    val own = ownWorkspaceId?.lowercase()
    synchronized(familyCopiesLock) {
        for (id in ids.map { it.lowercase() }) if (id != own) familyHeld.computeIfAbsent(id) { ConcurrentHashMap.newKeySet() }.add(groupId.lowercase())
    }
}

/* Held by a family whose guard is still owed: the barrier is up over it. Never past the guard's store, never ownership. */
internal fun Vault.heldUnderOwedGuard(workspaceId: String): Boolean =
    familyHeld[workspaceId.lowercase()]?.any { it in familyGuardOwed } == true

/*
 * Whether a workspace is a family folder, as far as this session knows: proven by route 25 and the id check, once named
 * always. Not by a member list's word (the ledger's own idea of its areas counts every folder a roster names, a share's
 * included), so a hostile roster never turns a share into a family folder here.
 */
fun Vault.isFamilyWorkspace(workspaceId: String): Boolean = familyAreas.containsKey(workspaceId.lowercase())

/* The family a family folder belongs to. */
fun Vault.familyOf(workspaceId: String): String? = familyAreas[workspaceId.lowercase()]

/* A family folder's top folder, listed through the ledger afresh (not from what this process opened before). */
internal fun Vault.openListed(node: NodeView): Opened = synchronized(this) {
    // Through the ledger only: a node of any workspace not named a family folder is refused before any cache is touched.
    if (!isFamilyWorkspace(node.workspaceId)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
    // A newer row of it already held stays: an older listing never replaces it (open keeps the newer one too).
    val held = nodes.row(node.workspaceId, node.id)
    if (held == null || !node.olderThan(held.node)) {
        nodes.forget(node.workspaceId, node.id)
        nodes.dropKey(node.workspaceId, node.id)
    }
    val item = open(node)
    node.parentId?.let { rememberParent(node.id, it) }
    item
}

/*
 * Everything opened in these family folders, forgotten (the web's deleteMirrors): keys, opened rows and their ids in the
 * node-to-parent index, and the plaintext copies opened from them in any session. Only family folders: a member list
 * naming the personal drive never clears it here (its copies are never under a family folder's). The node ids.
 */
internal fun Vault.forgetWorkspaces(ids: Collection<String>, words: String = FamilyWords.OPEN_AGAIN): Set<String> {
    // Invalidated first, then the copies deleted, under the lock family downloads write under: none writes after this.
    // Rows and keys dropped under it too, so an open that asked the ledger before this either lands first and is dropped
    // here, or finds the count moved and keeps nothing. Never this account's own drive, whatever a member list names.
    val gone = HashSet<String>()
    synchronized(familyCopiesLock) {
        // An ended session's cleanup touches nothing: the copies there now may be the next session's.
        if (closed) return gone
        for (id in ids) familyEpochs.compute(id.lowercase()) { _, old -> ((old?.first ?: 0L) + 1) to words }
        FamilyCopies.delete(context.cacheDir, ids)
        for (id in ids) if (!id.equals(ownWorkspaceId, ignoreCase = true)) {
            // The sealed thumbnails kept of what this session opened there go with the rows that named them.
            runCatching { mirror.dropThumbnails(nodes.rowsIn(id).mapNotNull { it.node.currentVersion?.id }) }
            gone.addAll(nodes.forgetWorkspace(id))
        }
    }
    forgetParents(gone)
    return gone
}

/*
 * The plaintext copies of these family folders, deleted (a family's clear on screen): under the copies lock, moving
 * their invalidation counts first so no download of them writes after, and never from a vault whose session ended.
 */
fun Vault.forgetFamilyCopies(ids: Collection<String>) = synchronized(familyCopiesLock) {
    if (closed) return@synchronized
    for (id in ids) familyEpochs.compute(id.lowercase()) { _, old -> ((old?.first ?: 0L) + 1) to FamilyWords.OPEN_AGAIN }
    FamilyCopies.delete(context.cacheDir, ids)
}

/*
 * The allowlist sweep: every family copy folder (cache/opened/family/<workspace>) whose workspace isn't in `keep`, deleted,
 * its invalidation moved first so no download of it writes after. Under the copies lock, and never from a closed vault.
 * Copies are cleaned whatever any record remembers; an empty `keep` (a cold start) deletes them all, which only costs a
 * download again.
 */
internal fun Vault.sweepFamilyCopies(keep: Set<String>) = synchronized(familyCopiesLock) {
    if (closed) return@synchronized
    val kept = keep.map { it.lowercase() }.toSet()
    for (folder in File(context.cacheDir, "opened/family").listFiles().orEmpty()) {
        val workspace = folder.name.lowercase()
        if (workspace in kept) continue
        familyEpochs.compute(workspace) { _, old -> ((old?.first ?: 0L) + 1) to FamilyWords.OPEN_AGAIN }
        folder.deleteRecursively()
    }
}

/* A family folder's invalidation count (0 until a forget): a download or a listing captures it before it begins. */
internal fun Vault.familyEpoch(workspaceId: String): Long = familyEpochs[workspaceId.lowercase()]?.first ?: 0L

/* The family's words when its folder was let go of since `epoch`; null while it stands. */
internal fun Vault.familyWordsSince(workspaceId: String, epoch: Long): String? {
    val now = familyEpochs[workspaceId.lowercase()]
    return if ((now?.first ?: 0L) != epoch) now?.second ?: FamilyWords.OPEN_AGAIN else null
}

/* Throws the family's words when its folder was let go of since `epoch`. */
internal fun Vault.requireFamilyEpoch(workspaceId: String, epoch: Long) {
    familyWordsSince(workspaceId, epoch)?.let { throw FamilyFailure(it) }
}

/* What family folders don't offer (sharing, links, reports, keeping, versions, copies): refused before anything is sent. */
internal fun Vault.refuseFamilyWrite(workspaceId: String) {
    heldBarrier(workspaceId)
    if (!isFamilyWorkspace(workspaceId)) {
        WriteIntent.record(workspaceId, false)
        return
    }
    requireGuardKept(workspaceId)
    throw FamilyUnavailable()
}

/* A folder only held for a family's barrier: refused while that family's guard is owed, and otherwise left alone. */
private fun Vault.heldBarrier(workspaceId: String) {
    if (isFamilyWorkspace(workspaceId)) return
    if (heldUnderOwedGuard(workspaceId)) throw GuardUnsaved()
}

/*
 * The web worker's requireGuardKept (docs/optional-verification.md 2.8): nothing is written into a family while the
 * guard its last acceptance handed back isn't stored; reading goes on. A family folder whose family isn't known here is
 * refused while any family's guard is owed.
 */
internal fun Vault.requireGuardKept(workspaceId: String) {
    if (familyGuardOwed.isEmpty()) return
    val groupId = familyAreas[workspaceId.lowercase()]
    if (groupId == null || groupId in familyGuardOwed) throw GuardUnsaved()
}

/* Right before a write leaves for the server: a sync may have committed and failed to store its guard meanwhile. */
internal fun Vault.sendingIntoFamily(workspaceId: String) = finalWriteGate(workspaceId)

/* Raised before an acceptance of `groupId` commits; whether it was raised already (an earlier guard still owed). */
internal fun Vault.oweFamilyGuard(groupId: String): Boolean = !familyGuardOwed.add(groupId.lowercase())

/* The guard an acceptance handed back is stored (or it had none): writes into the family go on. */
internal fun Vault.familyGuardKept(groupId: String) { familyGuardOwed.remove(groupId.lowercase()) }

/*
 * The family guard for the core: what this phone holds, or Unreadable when its store could not be read, which the core
 * refuses (never first use). Read afresh for every call.
 */
internal fun Vault.heldFamilyGuard(groupId: String): FamilyGuard = try {
    familyGuard.family(groupId)?.let { FamilyGuard.Held(it) } ?: FamilyGuard.Absent
} catch (_: Exception) {
    FamilyGuard.Unreadable
}

/*
 * A guard an acceptance (or a wipe) handed back, stored (merged, never lower) before anything else of it is. Throws
 * GuardUnsaved when it isn't on disk, FamilyGuardConflict for another history.
 */
internal fun Vault.keepFamilyGuard(groupId: String, pin: GroupPin): GroupPin {
    val kept = try {
        familyGuard.keep(groupId, pin)
    } catch (error: FamilyGuardConflict) {
        throw error
    } catch (_: Exception) {
        throw GuardUnsaved()
    }
    afterFamilyGuard?.invoke()
    return kept
}

/* The trust set and the pins it was built from, from one guarded read: the writers a family's verdicts judge by. */
internal fun Vault.trustAndPins(): Pair<Trust, List<ContactPin>> {
    val all = identities(strict = true)
    val pins = effectivePins()
    return Trust.of(api.session.userId, base64urlDecode(all[0].signingPublicKey), all.drop(1).map { base64urlDecode(it.signingPublicKey) }, pins) to pins
}

/* Whether two servings of a node carry the same keys and records: anything else is opened again (a rename, a version, a re-key). */
internal fun sameRecords(a: NodeView, b: NodeView): Boolean =
    a.parentId == b.parentId && a.keyEpoch == b.keyEpoch && a.parentKeyEpoch == b.parentKeyEpoch && a.keyEnvelope == b.keyEnvelope &&
        a.metadataVersion == b.metadataVersion && a.metadataEnvelope == b.metadataEnvelope && a.metadataSignature == b.metadataSignature &&
        a.currentVersion == b.currentVersion && a.trashedAt == b.trashedAt && a.rawJson == b.rawJson
