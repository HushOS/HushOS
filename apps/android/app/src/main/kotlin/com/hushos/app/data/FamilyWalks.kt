package com.hushos.app.data

import com.hushos.core.CoreException
import com.hushos.core.NodeKind
import com.hushos.core.RotatedNode
import com.hushos.core.RotatedRecord
import com.hushos.core.RotatingNode
import com.hushos.core.RotatingVersion
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock

/*
 * A member's side of a removal (docs/groups-mobile-plan.md, Android 4; the web's lib/groups/walks.ts and the family case of
 * packages/drive's runRotation): the key change a member list started in a family folder walked to its end on this phone,
 * through the area ledger's `rotate_node`, by whoever in the family gets there first. Run in the foreground while the app
 * shows the family, and as WorkManager work (FamilyWalkWork) so it finishes with the app closed.
 */

/* A run of a family folder's key change, as a walk is given it (the web's WalkTarget). */
data class WalkTarget(val workspaceId: String, val rotationId: String?, val nodeId: String, val targetEpoch: ULong)

/*
 * Whether this phone has its own reason to walk the run route 25 names in a folder (the web's ownReasonToWalk): a roster
 * rotation of the folder (the member list moved it to a new key and re-keyed its top folder at the walk's target), which
 * the phone saw for itself, since the top folder opened here under the folder's latest key with that very key epoch. Any
 * other run the server names (a holder's Drive walk of a subtree, or one made up) is never walked on the server's word.
 */
fun ownReasonToWalk(area: FamilyArea): Boolean {
    val rotation = area.rotation ?: return false
    val root = area.root ?: return false
    return area.opened && area.rootListed && rotation.nodeId.equals(root.id, ignoreCase = true) && rotation.targetEpoch == root.keyEpoch
}

/* The run this phone walks in `area`, or null when it has no reason of its own to. */
fun FamilyArea.walkTarget(): WalkTarget? =
    rotation?.takeIf { ownReasonToWalk(this) }?.let { WalkTarget(workspaceId, it.id, it.nodeId, it.targetEpoch) }

/* A walk that stopped short of its end, in the web's words for why. */
class WalkStopped(message: String) : Exception(message)

/* How a walk ended: walked to its end here, or ended by another device meanwhile (route 25 no longer runs it). */
enum class WalkEnd { WALKED, ENDED_ELSEWHERE }

/*
 * One walk of a folder at a time in this process (the web's per-folder lock): the app's, the Files app's and a WorkManager
 * job's vaults share the process, and two walks of one folder would each make fresh keys for the same nodes. A second
 * walk waits, then finds the run finished (route 25, or the work's `done`).
 */
object FamilyWalkLocks {
    private val locks = ConcurrentHashMap<String, ReentrantLock>()

    fun <T> hold(workspaceId: String, body: () -> T): T {
        val lock = locks.getOrPut(workspaceId.lowercase()) { ReentrantLock() }
        lock.lock()
        try { return body() } finally { lock.unlock() }
    }
}

/* Whether route 25 still names the run as the folder's running one (the web's stillRunning). A folder not listed runs nothing of ours. */
fun stillRunning(spaces: Map<String, List<SpaceArea>>, groupId: String, run: WalkTarget): Boolean {
    val area = spaces[groupId.lowercase()].orEmpty().firstOrNull { it.workspaceId.equals(run.workspaceId, ignoreCase = true) } ?: return false
    val rotation = area.rotation ?: return false
    return if (run.rotationId != null) rotation.id == run.rotationId else rotation.nodeId.equals(run.nodeId, ignoreCase = true) && rotation.targetEpoch == run.targetEpoch
}

/*
 * Walks a run to its end (the web's walkToEnd), one walk of the folder at a time: a run route 25 no longer names (another
 * device finished it while this one waited, or a 404 from its work) is ended elsewhere, never failed; a 404 while it still
 * runs is the walk failing.
 */
fun FamilySync.walk(groupId: String, target: WalkTarget, progress: (Int) -> Unit = {}): WalkEnd = FamilyWalkLocks.hold(target.workspaceId) {
    if (!stillRunning(api.spaces(), groupId, target)) return@hold WalkEnd.ENDED_ELSEWHERE
    try {
        vault.walkFamilyFolder(target, progress)
        WalkEnd.WALKED
    } catch (error: NotFound) {
        if (!stillRunning(api.spaces(), groupId, target)) WalkEnd.ENDED_ELSEWHERE else throw error
    }
}

/*
 * The walk itself (packages/drive's runRotation for a family folder): the server hands out the work parents first; each
 * node goes through the ledger's `rotate_node` (a fresh key wrapped under its parent at the target, its records re-keyed
 * raw under it and signed with this account's key, or a node already at the target re-wrapped), and the batch is sent.
 * A family write like any other: decided at its entry (`familyTarget`, recorded for the final gate), every send through
 * `DriveApi.beforeWrite`'s final gate, and refused once the folder was let go of since it began. The fresh keys become the
 * nodes' own (`rotate_commit`) only for what the server applied; whatever stops a batch drops the rest (`rotate_drop`),
 * so a retry walks those nodes again rather than finding them pending. A process killed mid-batch held its pending keys
 * in memory only: the next walk is given the same nodes and sends them again under keys of its own. The number of nodes
 * this walk re-keyed.
 */
internal fun Vault.walkFamilyFolder(target: WalkTarget, progress: (Int) -> Unit = {}): Int = writing {
    val ws = target.workspaceId
    val rootId = target.nodeId
    val epoch = target.targetEpoch
    // Decided once, at entry, as every family write is: the ledger's own folder, writable now.
    if (!familyTarget(ws)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
    val began = WriteIntent.epoch(ws) ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
    val seed = identityKeys().signingSeed
    // The top folder's own listing through the ledger: what its children are wrapped under, at the target.
    listChildren(rootId, ws)
    var done = 0
    var cursor: String? = null
    var idle = 0
    // A node the ledger would not carry into the new tree (only a manager clears it), and one with shares or links.
    var notCarried = false
    var shared = false
    while (true) {
        requireFamilyEpoch(ws, began)
        val work = api.rotationWork(ws, rootId, cursor)
        if (work.done) break
        // Another run than the one this walk was given (a newer key change): left to the sync that names it.
        if (work.targetEpoch != epoch) throw WalkStopped("The rotation could not finish. Try again.")
        if (work.nodes.isEmpty()) {
            cursor = null
            if (++idle > 3) throw WalkStopped("The rotation could not finish. Try again.")
            continue
        }
        if (work.nodes.any { !it.node.workspaceId.equals(ws, ignoreCase = true) }) throw ApiError(502, "HushOS answered with nodes of another drive.")
        work.nodes.forEach { checkSuite(it.node.envelopeSuite) }
        // Parents not opened at the target here (a resumed walk, a deep folder): listing a parent opens it through the
        // ledger, and mid-rotation its previous key too.
        val inBatch = work.nodes.map { it.node.id }.toSet()
        for (parentId in work.nodes.mapNotNull { it.node.parentId }.toSet()) {
            if (parentId in inBatch || areaLedger.nodeKey(ws, parentId)?.epoch == epoch) continue
            runCatching { listChildren(parentId, ws) }
        }
        // A family folder takes no shares or links (design 3.4): a node with any is refused by the core alike, and left.
        val unshared = work.nodes.filter { it.shares.isEmpty() && it.links.isEmpty() }
        if (unshared.size < work.nodes.size) shared = true
        // Only nodes whose parent's key at the target is the server's already: never one beside its parent in the same
        // batch. The server applies each node on its own, so another device walking the same run can win the parent
        // (ours `stale`) while ours wins the child (`ok`), which would leave the child sealed under a key nobody kept.
        // The children wait for a later batch, once the parent's key is confirmed (committed here, or listed as the
        // other device's).
        val sending = deferChildren(unshared)
        val made = ArrayList<String>()
        val kept = HashSet<String>()
        var sent = false
        try {
            val batch = JSONArray()
            for (entry in sending) {
                val rotated = try {
                    areaLedger.rotateNode(ws, rotating(entry, rootId, epoch, ws), epoch, seed)
                } catch (refused: CoreException) {
                    val words = refused.message.orEmpty()
                    if (words.startsWith("This item was added under a key the key change replaces")) notCarried = true
                    if (words.startsWith("This item has shares or links")) shared = true
                    continue
                }
                made.add(entry.node.id)
                val metadata = rotated.metadata
                if (!rotated.rewrap && metadata?.signature == null && metadata?.rekey == null) throw WalkStopped("The rotation could not sign what it sealed. Try again.")
                batch.put(wire(entry.node, rotated, rootId, epoch))
            }
            if (batch.length() > 0) {
                // The walk's own count first (its folder let go of since it began), then the final gate on the way out.
                synchronized(familyCopiesLock) { requireWriteStands(ws) }
                sent = true
                val outcomes = api.rotateNodes(ws, rootId, batch)
                if (outcomes.any { it.second == "bad-signature" }) throw ApiError(400, "This change was not signed by your keys. Sign in again and retry.")
                outcomes.filter { it.second == "ok" || it.second == "already" }.forEach { kept.add(it.first) }
            }
        } finally {
            // The keys made become the nodes' own only for what the server applied; every other one is dropped, so a retry
            // walks those nodes again instead of finding them pending.
            areaLedger.rotateCommit(ws, made.filter { it in kept })
            areaLedger.rotateDrop(ws, made.filter { it !in kept })
            // Rows served at the old keys are read again through the ledger; a send whose answer never came may have landed.
            if (sent) for (id in made) nodes.forget(ws, id)
        }
        done += kept.size
        progress(done)
        idle = if (kept.isNotEmpty()) 0 else idle + 1
        if (idle > 3) throw WalkStopped(
            when {
                shared -> "An item in this family folder has shares or links, which family folders don’t support, so its keys weren’t changed. The key change can finish once they’re stopped."
                notCarried -> "One item in this folder can’t take the new keys. A manager can move it to Trash and delete it forever, then the key change finishes."
                else -> "The rotation could not finish. Try again."
            },
        )
        // Everything applied: on past the batch; otherwise from the start, so parents come first.
        cursor = if (kept.size == work.nodes.size) work.nextCursor else null
    }
    done
}

/*
 * The nodes of a batch that may be sealed now: none whose parent is in the same batch (its fresh key would still be
 * pending, so the server could take the child and refuse the parent). Parents come first in the work, so a later batch
 * brings each deferred child once its parent's key is confirmed.
 */
internal fun deferChildren(nodes: List<RotationWorkNode>): List<RotationWorkNode> {
    val inBatch = nodes.map { it.node.id.lowercase() }.toSet()
    return nodes.filter { entry -> entry.node.parentId?.lowercase()?.let { it in inBatch } != true }
}

/* A node of the work as the ledger's walk takes it: its parent's key at the target, or the top folder's own. */
private fun rotating(entry: RotationWorkNode, rootId: String, target: ULong, ws: String): RotatingNode {
    val node = entry.node
    val raw = runCatching { JSONObject(node.rawJson) }.getOrNull()
    fun bytes(value: String) = runCatching { base64urlDecode(value) }.getOrDefault(ByteArray(0))
    return RotatingNode(
        node.id, node.parentId ?: ws, if (node.id == rootId) node.parentKeyEpoch else target, node.keyEpoch, node.parentKeyEpoch,
        bytes(node.keyEnvelope), if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion, bytes(node.metadataEnvelope),
        node.metadataSigner?.id, FamilySync.signature(node.metadataSignature), FamilySync.rekey(raw?.optJSONObject("metadataRekey")),
        entry.versions.map { version ->
            RotatingVersion(version.getString("id"), version.getString("objectId"), version.getInt("contentSuite").toUInt(), bytes(version.getString("contentKeyEnvelope")),
                version.optJSONObject("signer")?.optString("id")?.ifEmpty { null }, FamilySync.signature(version.opt("signature").takeIf { !version.isNull("signature") }),
                FamilySync.rekey(version.optJSONObject("rekey")))
        },
        entry.shares.map { it.optString("id") }, entry.links.map { it.optString("id") },
    )
}

/* One node of the batch as the server's rotation takes it (rotatedNodeSchema): its key, and its records re-keyed or none. */
private fun wire(node: NodeView, rotated: RotatedNode, rootId: String, target: ULong): JSONObject {
    fun rekey(record: RotatedRecord) = record.rekey?.let { JSONObject().put("originKeyEnvelope", base64urlEncode(it.originKeyEnvelope)).put("signature", base64urlEncode(it.signature)) }
    val out = JSONObject().put("id", node.id).put("changeSeq", node.changeSeq ?: 0)
        .put("parentKeyEpoch", (if (node.id == rootId) node.parentKeyEpoch else target).toLong()).put("keyEnvelope", base64urlEncode(rotated.keyEnvelope))
    val metadata = rotated.metadata
    if (rotated.rewrap || metadata == null) return out.put("rotated", JSONObject.NULL)
    val records = JSONObject().put("metadataEnvelope", base64urlEncode(metadata.envelope))
        .put("metadataSignature", metadata.signature?.let(::base64urlEncode) ?: JSONObject.NULL).put("metadataRekey", rekey(metadata) ?: JSONObject.NULL)
    if (metadata.dropOrigin) records.put("metadataDropOrigin", true)
    records.put("versions", JSONArray(rotated.versions.map { version ->
        JSONObject().put("id", version.versionId).put("contentKeyEnvelope", base64urlEncode(version.record.envelope))
            .put("signature", version.record.signature?.let(::base64urlEncode) ?: JSONObject.NULL).put("rekey", rekey(version.record) ?: JSONObject.NULL)
            .apply { if (version.record.dropOrigin) put("dropOrigin", true) }
    }))
    // A family folder has none of these to seal again: an item with any was left out above.
    return out.put("rotated", records.put("shares", JSONArray()).put("links", JSONArray()).put("unsealableLinks", JSONArray()))
}
