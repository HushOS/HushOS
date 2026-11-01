package com.hushos.app.data

import com.hushos.core.FamilyGuard
import com.hushos.core.FamilyChecked
import com.hushos.core.GroupPin
import com.hushos.core.IdentityEnvelope
import com.hushos.core.OwnIdentities
import com.hushos.core.ServedKeys
import com.hushos.core.ServedNodeKey
import com.hushos.core.base64urlDecode
import org.json.JSONObject
import java.io.File

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
    for (id in ids.map { it.lowercase() }) if (id != own) familyAreas[id] = groupId.lowercase()
}

/*
 * Held for the write barrier (a roster's word, familyHeld): never a family folder by it, and never over a folder already
 * held for another family. Only route 25 with the id check (noteFamilyWorkspaces) makes a workspace a family folder.
 */
internal fun Vault.holdAsFamilyWorkspaces(ids: Collection<String>, groupId: String) {
    val own = ownWorkspaceId?.lowercase()
    for (id in ids.map { it.lowercase() }) if (id != own) familyHeld.putIfAbsent(id, groupId.lowercase())
}

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
        for (id in ids) if (!id.equals(ownWorkspaceId, ignoreCase = true)) gone.addAll(nodes.forgetWorkspace(id))
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

/* What family folders don't take on Android yet: refused before anything is sent, after the write barrier. */
internal fun Vault.refuseFamilyWrite(workspaceId: String) {
    heldBarrier(workspaceId)
    if (!isFamilyWorkspace(workspaceId)) return
    requireGuardKept(workspaceId)
    throw FamilyReadOnly()
}

/* A folder only held for a family's barrier: refused while that family's guard is owed, and otherwise left alone. */
private fun Vault.heldBarrier(workspaceId: String) {
    if (isFamilyWorkspace(workspaceId)) return
    val held = familyHeld[workspaceId.lowercase()] ?: return
    if (held in familyGuardOwed) throw GuardUnsaved()
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
internal fun Vault.sendingIntoFamily(workspaceId: String) {
    heldBarrier(workspaceId)
    if (isFamilyWorkspace(workspaceId)) requireGuardKept(workspaceId)
}

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
