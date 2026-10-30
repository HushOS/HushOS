package com.hushos.app.data

import com.hushos.core.LinkContext
import com.hushos.core.MetadataContext
import com.hushos.core.NodeKind
import com.hushos.core.NodeKeyContext
import com.hushos.core.ShareContext
import com.hushos.core.VersionContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.linkSeal
import com.hushos.core.linkSecretOpen
import com.hushos.core.linkSecretSeal
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.nodeOpen
import com.hushos.core.nodeWrap
import com.hushos.core.randomBytes
import com.hushos.core.shareSeal
import com.hushos.core.versionOpen
import com.hushos.core.versionReseal
import org.json.JSONArray
import org.json.JSONObject

/* A node the rotation still has to visit, with everything sealed under its key. */
data class RotationWorkNode(
    val node: NodeView,
    val versions: List<JSONObject>,
    val shares: List<JSONObject>,
    val links: List<JSONObject>,
)

data class RotationWork(val targetEpoch: ULong, val nodes: List<RotationWorkNode>, val nextCursor: String?, val done: Boolean)

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

class RotationStuck : Exception("The rotation could not finish. Try again.")

/* How many nodes a rotation re-sealed, and the people it left out with why, to be said rather than dropped quietly. */
data class RotationResult(val done: Int, val skipped: List<String>)

/* A share row the rotation re-seals: the grantee's pinned X25519 key and their checked ML-KEM key. */
class ResealShare(val id: String, val granteeUserId: String, val publicKey: ByteArray, val kemPublicKey: ByteArray)

/* What one node's served shares and links come to: the share rows re-sealed, the links re-sealed, and why anyone was left out. */
class ResealPlan(val shares: List<ResealShare>, val links: List<JSONObject>, val skipped: List<String>)

/*
 * Which of a node's served shares and links are sealed again: the server's lists are only a claim, so a share is
 * re-sealed only when the ledger holds (node, grantee) and `sealTo` vouches for the keys served for them now (the pin,
 * as this phone's guard allows it: Vault.trustGrantee), and a link only when the ledger maps it to this node. Anything
 * else is left out of the batch and the server revokes it. A person the ledger holds but whose keys fail the check (a
 * changed account waits for Continue) is named in `skipped`; never sealed to X25519 alone.
 */
fun planReseal(nodeId: String, shares: List<JSONObject>, links: List<JSONObject>, ledger: SharingLedger, sealTo: (granteeId: String, served: ServedIdentity) -> Pair<ByteArray, ByteArray>): ResealPlan {
    val sealed = ArrayList<ResealShare>()
    val skipped = ArrayList<String>()
    for (share in shares) {
        val granteeId = share.getString("granteeUserId")
        if (!ledger.hasShare(nodeId, granteeId)) continue
        try {
            val (publicKey, kem) = sealTo(granteeId, ServedIdentity.from(share.getJSONObject("grantee")))
            sealed.add(ResealShare(share.getString("id"), granteeId, publicKey, kem))
        } catch (verdict: Exception) {
            // Left out, the server revokes their share: only a verdict on them may do that (their account changed, they're
            // no longer in Contacts, they can't be sealed to). Anything else (the guard couldn't be read or written, the
            // pin moved meanwhile, settings refused, no network) stops the whole rotation before anything is sent, and
            // the next attempt (PendingRotations) tries again.
            // Full settings are no verdict on anyone (the sealer seals a legacy pin's own keys unsaved instead).
            val about = verdict is AccountChanged || verdict is SharingRefused || (verdict is ContactProblem && verdict.message != Settings.CONTACTS_FULL)
            if (!about) throw verdict
            skipped.add(verdict.message ?: "Someone lost access.")
        }
    }
    return ResealPlan(sealed, links.filter { ledger.hasLink(it.getString("id"), nodeId) }, skipped)
}

/*
 * The keys to seal to for a grantee the server names, as this phone's guard allows (Vault.trustGrantee): kept per
 * person and the full identity served, so another batch serving other keys for them is judged again, never sealed to
 * what was judged over these. Someone no longer in Contacts is left out.
 */
internal fun Vault.granteeSealer(pins: Settings): (String, ServedIdentity) -> Pair<ByteArray, ByteArray> {
    val judged = HashMap<String, Pair<ByteArray, ByteArray>>()
    return { granteeId, served ->
        val pin = pins.pinOf(granteeId) ?: throw SharingRefused("Someone no longer in Contacts lost access.")
        val grantee = Contact(granteeId, pin.name, pin.email, served)
        judged[grantee.trustKey] ?: trustGrantee(grantee, follow = false, sealUnsaved = true).also { judged[grantee.trustKey] = it }
    }
}

/*
 * Subtree rotation, as the web does it after a share is revoked: every node
 * below the root gets a fresh key at the target epoch, parents first; its
 * metadata, versions, live shares (to keys the pins vouch for) and links are
 * sealed again under it. The server hands out the work in depth order and
 * applies each batch; a node whose parent is not ready yet comes back later.
 *
 * Every record is checked before it is signed again (docs/integrity-design.md,
 * "Re-sealing never launders"): a verified one keeps the ordinary statement,
 * anything else is signed re-sealed. Without the trust set nothing is rotated:
 * it stops before starting and is tried again later (PendingRotations), never
 * marking everything re-sealed for a network blip.
 */
/* A node a rotation on this device re-keyed: its applied epoch, and the key its unreached children are wrapped under. */
internal class RotatedKey(val root: String, val epoch: ULong, val previousEpoch: ULong, val previousKey: ByteArray)

internal fun Vault.rotateSubtree(item: Opened, progress: (Int) -> Unit): RotationResult {
    val ws = item.node.workspaceId
    val rootId = item.id
    val trust = trustForWrite()
    val target = api.startRotation(ws, rootId)
    // The root's chain must be open: its parent key is what the new root key wraps under.
    if (item.isFolder) listChildren(rootId) else item.node.parentId?.let { listChildren(it) }
    val keys = identityKeys()
    // What may be sealed again: the owner's ledger and pins, never the server's list alone.
    val settings = loadSettings()
    val ledger = settings.ledger
    val sealTo = granteeSealer(settings)
    val skipped = LinkedHashSet<String>()
    val epochs = HashMap<String, ULong>().apply { nodes.rowsIn(ws).forEach { put(it.id, it.node.keyEpoch) } }
    val seals = ShareSeals.of(context)
    val previous = HashMap<String, Pair<ULong, ByteArray>>()
    // What an earlier run of this rotation already had applied: those nodes are at their new epoch, and the keys before
    // it still open what that run didn't reach (their rows were dropped to be read again).
    for ((at, kept) in rotatedKeys.entries.toList()) {
        if (at.first != ws) continue
        // A row read since at another epoch (another device went on) is what holds: the kept key is stale.
        val row = nodes.row(ws, at.second)
        if (row != null && row.node.keyEpoch != kept.epoch) { rotatedKeys.remove(at); continue }
        epochs[at.second] = kept.epoch
        previous[at.second] = kept.previousEpoch to kept.previousKey
    }
    var done = 0
    var cursor: String? = null
    var idle = 0

    fun parentKey(parentId: String?, epoch: ULong): ByteArray? {
        // Only this account's own drive has its root under the workspace key.
        if (parentId == null) return if (ws == workspaceId) workspaceKeyBytes() else null
        if (epochs[parentId] == epoch) nodes.key(ws, parentId)?.let { return it }
        previous[parentId]?.let { if (it.first == epoch) return it.second }
        return null
    }

    while (true) {
        val work = api.rotationWork(ws, rootId, cursor)
        if (work.done) break
        if (work.nodes.isEmpty()) {
            cursor = null
            if (++idle > 3) throw RotationStuck()
            continue
        }
        // A node of another workspace is not this rotation's; one in a later format can't be re-sealed here.
        if (work.nodes.any { it.node.workspaceId != ws }) throw ApiError(502, "HushOS answered with nodes of another drive.")
        work.nodes.forEach { checkSuite(it.node.envelopeSuite) }
        val inBatch = work.nodes.map { it.node.id }.toSet()
        for (parentId in work.nodes.mapNotNull { it.node.parentId }.toSet()) {
            if (parentId !in inBatch && nodes.row(ws, parentId) == null && parentId !in epochs) {
                runCatching { listChildren(parentId) }
                nodes.row(ws, parentId)?.let { epochs[parentId] = it.node.keyEpoch }
            }
        }
        val batch = JSONArray()
        // What each node's re-sealed shares were sealed with, recorded once the server took that node.
        val sealedIn = HashMap<String, Map<String, ShareSeals.Seal>>()
        // What each node of this batch held before it was given a key here: a key becomes the node's own only once the
        // server applied the batch. Whatever stops it (a grantee check that isn't a verdict, a failure while sealing, a
        // dropped send) or refuses a node, those nodes get their old keys back, so the vault is as it was and a retry walks
        // them again from the keys the server holds (the web drops a stopped batch's keys the same way).
        val staged = HashMap<String, Triple<ByteArray?, ULong?, Pair<ULong, ByteArray>?>>()
        fun stage(id: String) {
            if (id !in staged) staged[id] = Triple(nodes.key(ws, id), epochs[id], previous[id])
        }
        fun unstage(ids: Collection<String>) {
            for (id in ids) {
                val (key, epoch, prior) = staged[id] ?: continue
                if (key == null) nodes.dropKey(ws, id) else nodes.putKey(ws, id, key)
                if (epoch == null) epochs.remove(id) else epochs[id] = epoch
                if (prior == null) previous.remove(id) else previous[id] = prior
            }
        }
        var sending = false
        var applied = 0
        try {
            for (entry in work.nodes) {
                val node = entry.node
                val newParentEpoch = if (node.id == rootId) node.parentKeyEpoch else target
                val wrappedUnder = parentKey(node.parentId, node.parentKeyEpoch) ?: continue
                val wrapUnder = parentKey(node.parentId, newParentEpoch) ?: continue
                val old: ByteArray = (if (epochs[node.id] == node.keyEpoch) nodes.key(ws, node.id) else null)
                    ?: nodeOpen(NodeKeyContext(ws, node.id, node.parentId ?: ws, node.parentKeyEpoch, node.keyEpoch), wrappedUnder, base64urlDecode(node.keyEnvelope))
                val wire = JSONObject().put("id", node.id).put("changeSeq", node.changeSeq ?: 0).put("parentKeyEpoch", newParentEpoch.toLong())
                if (node.keyEpoch >= target) {
                    // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
                    val envelope = nodeWrap(NodeKeyContext(ws, node.id, node.parentId ?: ws, newParentEpoch, node.keyEpoch), wrapUnder, old)
                    wire.put("keyEnvelope", base64urlEncode(envelope)).put("rotated", JSONObject.NULL)
                    stage(node.id)
                    nodes.putKey(ws, node.id, old)
                    epochs[node.id] = node.keyEpoch
                    batch.put(wire)
                    continue
                }
                val fresh = randomBytes(32u)
                val envelope = nodeWrap(NodeKeyContext(ws, node.id, node.parentId ?: ws, newParentEpoch, target), wrapUnder, fresh)
                val metaCtx = MetadataContext(ws, node.id, node.metadataVersion)
                val metadataEnvelope = metadataSeal(metaCtx, fresh, metadataOpen(metaCtx, old, base64urlDecode(node.metadataEnvelope)))
                // Every re-sealed envelope is signed by the account running the rotation, at the node's unchanged metadata
                // version, as the record checked before: ordinary only when it verified.
                val metadataSignature = signMetadata(ws, node.id, if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion, metadataEnvelope,
                    metadataVerdict(node, trust))
                val versions = JSONArray()
                for (version in entry.versions) {
                    val ctx = VersionContext(ws, node.id, version.getString("id"), version.getString("objectId"))
                    val suite = version.getInt("contentSuite").toUInt()
                    val envelope = version.getString("contentKeyEnvelope")
                    val prior = versionVerdict(ws, node.id, ctx.versionId, ctx.objectId, suite, envelope,
                        version.optJSONObject("signer")?.optString("id")?.ifEmpty { null }, version.optString("signature").takeIf { !version.isNull("signature") && it.isNotEmpty() }, trust)
                    val rowSize = version.optString("plaintextSize").takeIf { !version.isNull("plaintextSize") }?.toULongOrNull()
                    val content = versionOpen(ctx, suite, old, base64urlDecode(envelope), rowSize)
                    val resealed = versionReseal(ctx, suite, fresh, content)
                    versions.put(JSONObject().put("id", version.getString("id")).put("contentKeyEnvelope", base64urlEncode(resealed))
                        .put("signature", signVersion(ws, node.id, ctx.versionId, ctx.objectId, suite, resealed, prior)))
                }
                val plan = planReseal(node.id, entry.shares, entry.links, ledger, sealTo)
                skipped.addAll(plan.skipped)
                val shares = JSONArray()
                val sealedHere = HashMap<String, ShareSeals.Seal>()
                for (share in plan.shares) {
                    val ctx = ShareContext(ws, node.id, target, share.granteeUserId, api.session.userId)
                    shares.put(JSONObject().put("id", share.id).put("shareEnvelope", base64urlEncode(shareSeal(ctx, fresh, keys, share.publicKey, share.kemPublicKey))))
                    val served = entry.shares.firstOrNull { it.optString("id") == share.id }?.optJSONObject("grantee")?.let { ServedIdentity.from(it) }
                    sealedHere[share.id] = ShareSeals.Seal(keys.keyVersion, served?.keyVersion)
                }
                sealedIn[node.id] = sealedHere
                val links = JSONArray()
                val unsealable = JSONArray()
                for (link in plan.links) {
                    val id = link.getString("id")
                    // No sealed secret, a row naming an older derivation, or a secret that no longer opens: a link to end, not a rotation to fail.
                    if (link.isNull("secretEnvelope") || (!link.isNull("kdfVersion") && !LinkKdf.current(link.optInt("kdfVersion")))) { unsealable.put(id); continue }
                    val owned = runCatching {
                        linkSecretOpen(LinkContext(ws, node.id, node.keyEpoch, id), old, base64urlDecode(link.getString("secretEnvelope")))
                    }.getOrNull()
                    if (owned == null) { unsealable.put(id); continue }
                    // A password link sealed before the password key was kept cannot be re-sealed without the password.
                    if (link.getBoolean("hasPassword") && owned.fromPassword == null) { unsealable.put(id); continue }
                    val stretched = owned.fromPassword ?: ByteArray(32)
                    val newCtx = LinkContext(ws, node.id, target, id)
                    links.put(JSONObject().put("id", id)
                        .put("linkEnvelope", base64urlEncode(linkSeal(newCtx, fresh, owned.secret, stretched)))
                        .put("secretEnvelope", base64urlEncode(linkSecretSeal(newCtx, fresh, owned.secret, owned.token, stretched))))
                }
                wire.put("keyEnvelope", base64urlEncode(envelope)).put("rotated", JSONObject()
                    .put("metadataEnvelope", base64urlEncode(metadataEnvelope)).put("metadataSignature", metadataSignature)
                    .put("versions", versions).put("shares", shares)
                    .put("links", links).put("unsealableLinks", unsealable))
                // From here the node's key is the fresh one; the old one stays reachable for its unrotated children.
                stage(node.id)
                previous[node.id] = node.keyEpoch to old
                nodes.putKey(ws, node.id, fresh)
                epochs[node.id] = target
                batch.put(wire)
            }
            if (batch.length() > 0) {
                sending = true
                val outcomes = api.rotateNodes(ws, rootId, batch)
                // A signature the server could not verify is a bug here, not a race: trying again would loop until stuck.
                if (outcomes.any { it.second == "bad-signature" }) throw ApiError(400, "This change was not signed by your keys. Sign in again and retry.")
                val kept = outcomes.filter { it.second == "ok" || it.second == "already" }.map { it.first }.toSet()
                applied = kept.size
                // A node the server refused (or left out) keeps the key it holds there.
                unstage(staged.keys.filter { it !in kept })
                // What the server applied is committed here at once, so a later batch that stops has only its own nodes to
                // undo: their rows (still at the old epoch) are read again, and a re-keyed node's previous key is kept for
                // the children the walk hasn't reached, past this run if it stops.
                for (id in staged.keys) {
                    if (id !in kept) continue
                    val epoch = epochs[id]
                    val prior = previous[id]
                    if (epoch != null && prior != null && prior.first != epoch) rotatedKeys[ws to id] = RotatedKey(rootId, epoch, prior.first, prior.second)
                    nodes.forget(ws, id)
                }
                if (kept.isNotEmpty()) catalogueState = CatalogueState.IDLE
                for ((id, outcome) in outcomes) if (outcome == "ok") sealedIn[id]?.let { seals.record(it) }
            }
        } catch (stopped: Exception) {
            unstage(staged.keys.toList())
            // A send whose answer never came may have landed: those nodes are read from the server again, under whichever
            // keys it holds, rather than trusted from what this vault opened before.
            if (sending) {
                staged.keys.forEach { nodes.forget(ws, it) }
                // The catalogue lists children through those rows: answered from it now, the folders would lose them.
                catalogueState = CatalogueState.IDLE
            }
            throw stopped
        }
        done += applied
        progress(done)
        idle = if (applied > 0) 0 else idle + 1
        if (idle > 3) throw RotationStuck()
        // Everything applied: continue past the batch; otherwise start over so parents come first.
        cursor = if (applied == work.nodes.size) work.nextCursor else null
    }
    // Envelopes changed under every folder: what this device listed is stale.
    nodes.forgetRows()
    // Every node is under the new keys now: no child is left wrapped under a previous one.
    rotatedKeys.entries.removeIf { (at, kept) -> at.first == ws && kept.root == rootId }
    return RotationResult(done, skipped.toList())
}

/*
 * Rotations started and not finished: one that stopped (the trust set didn't load, the network dropped) is tried again
 * at the next Drive open, so a revoke never leaves a subtree half re-locked for long. Account data: a sign-out removes it.
 */
class PendingRotations(private val file: java.io.File) {
    private fun read(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        val next = java.io.File(file.path + ".next")
        next.writeText(json.toString())
        if (!next.renameTo(file)) { file.writeText(json.toString()); next.delete() }
    }

    fun add(workspaceId: String, nodeId: String) = synchronized(LOCK) { write(read().put("$workspaceId/$nodeId", System.currentTimeMillis())) }

    fun remove(workspaceId: String, nodeId: String) = synchronized(LOCK) { val json = read(); if (json.remove("$workspaceId/$nodeId") != null) write(json) }

    /* (workspace, node) pairs, oldest first. */
    fun all(): List<Pair<String, String>> = synchronized(LOCK) {
        val json = read()
        json.keys().asSequence().toList().sortedBy { json.optLong(it) }.mapNotNull { key ->
            key.split("/").takeIf { it.size == 2 }?.let { it[0] to it[1] }
        }
    }

    companion object {
        private val LOCK = Any()
        const val FILE = "pending-rotations.json"

        fun of(context: android.content.Context) = PendingRotations(java.io.File(context.filesDir, FILE))
    }
}
