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

/* A share row the rotation re-seals: the grantee's pinned X25519 key and their checked post-quantum key. */
class ResealShare(val id: String, val granteeUserId: String, val publicKey: ByteArray, val kemPublicKey: ByteArray)

/*
 * What one node's served shares and links come to: the share rows re-sealed, the links re-sealed, why anyone
 * was left out, and post-quantum key digests seen for the first time (user id -> digest), for their pins.
 */
class ResealPlan(val shares: List<ResealShare>, val links: List<JSONObject>, val skipped: List<String>, val firstKems: Map<String, String>)

/*
 * Which of a node's served shares and links are sealed again: the server's lists are only a claim,
 * so a share is re-sealed only when the ledger holds (node, grantee) and the pin vouches for the keys
 * served for them now, and a link only when the ledger maps it to this node. Anything else is left out
 * of the batch and the server revokes it. A person the ledger holds but whose keys fail the check is
 * named in `skipped`; never sealed to X25519 alone.
 */
fun planReseal(nodeId: String, shares: List<JSONObject>, links: List<JSONObject>, ledger: SharingLedger, pins: Map<String, ContactPin>): ResealPlan {
    val sealed = ArrayList<ResealShare>()
    val skipped = ArrayList<String>()
    val firstKems = HashMap<String, String>()
    for (share in shares) {
        val granteeId = share.getString("granteeUserId")
        if (!ledger.hasShare(nodeId, granteeId)) continue
        val pin = pins[granteeId]
        if (pin == null) { skipped.add("Someone no longer in People you share with lost access."); continue }
        val served = share.getJSONObject("grantee")
        if (!pin.matches(ServedIdentity.from(served))) {
            skipped.add("${pin.displayName}’s key has changed since you pinned it. Check it’s them in People you share with, then share again."); continue
        }
        val kem = served.optJSONObject("kem")
        try {
            val checked = granteeKem(pin, kem?.optString("publicKey")?.ifEmpty { null }, kem?.optString("signature")?.ifEmpty { null })
            sealed.add(ResealShare(share.getString("id"), granteeId, base64urlDecode(pin.encryptionPublicKey), checked.publicKey))
            checked.firstHash?.let { firstKems[granteeId] = it }
        } catch (refused: SharingRefused) {
            skipped.add(refused.message ?: "${pin.displayName} lost access.")
        }
    }
    return ResealPlan(sealed, links.filter { ledger.hasLink(it.getString("id"), nodeId) }, skipped, firstKems)
}

/*
 * Subtree rotation, as the web does it after a share is revoked: every node
 * below the root gets a fresh key at the target epoch, parents first; its
 * metadata, versions, live shares (to keys the pins vouch for) and links are
 * sealed again under it. The server hands out the work in depth order and
 * applies each batch; a node whose parent is not ready yet comes back later.
 */
internal fun Vault.rotateSubtree(item: Opened, progress: (Int) -> Unit): RotationResult {
    val ws = item.node.workspaceId
    val rootId = item.id
    val target = api.startRotation(ws, rootId)
    // The root's chain must be open: its parent key is what the new root key wraps under.
    if (item.isFolder) listChildren(rootId) else item.node.parentId?.let { listChildren(it) }
    val keys = identityKeys()
    // What may be sealed again: the owner's ledger and pins, never the server's list alone.
    val settings = loadSettings()
    val pins = HashMap(settings.contacts)
    val ledger = settings.ledger
    val skipped = LinkedHashSet<String>()
    val firstKems = HashMap<String, String>()
    val epochs = HashMap<String, ULong>().apply { nodes.rowsIn(ws).forEach { put(it.id, it.node.keyEpoch) } }
    val seals = ShareSeals.of(context)
    val previous = HashMap<String, Pair<ULong, ByteArray>>()
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
            if (parentId !in inBatch && nodes.row(ws, parentId) == null) {
                runCatching { listChildren(parentId) }
                nodes.row(ws, parentId)?.let { epochs[parentId] = it.node.keyEpoch }
            }
        }
        val batch = JSONArray()
        // What each node's re-sealed shares were sealed with, recorded once the server took that node.
        val sealedIn = HashMap<String, Map<String, ShareSeals.Seal>>()
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
                nodes.putKey(ws, node.id, old)
                epochs[node.id] = node.keyEpoch
                batch.put(wire)
                continue
            }
            val fresh = randomBytes(32u)
            val envelope = nodeWrap(NodeKeyContext(ws, node.id, node.parentId ?: ws, newParentEpoch, target), wrapUnder, fresh)
            val metaCtx = MetadataContext(ws, node.id, node.metadataVersion)
            val metadataEnvelope = metadataSeal(metaCtx, fresh, metadataOpen(metaCtx, old, base64urlDecode(node.metadataEnvelope)))
            // Every re-sealed envelope is signed by the account running the rotation, at the node's unchanged metadata version.
            val metadataSignature = signMetadata(ws, node.id, if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion, metadataEnvelope)
            val versions = JSONArray()
            for (version in entry.versions) {
                val ctx = VersionContext(ws, node.id, version.getString("id"), version.getString("objectId"))
                val suite = version.getInt("contentSuite").toUInt()
                val rowSize = version.optString("plaintextSize").takeIf { !version.isNull("plaintextSize") }?.toULongOrNull()
                val content = versionOpen(ctx, suite, old, base64urlDecode(version.getString("contentKeyEnvelope")), rowSize)
                val resealed = versionReseal(ctx, suite, fresh, content)
                versions.put(JSONObject().put("id", version.getString("id")).put("contentKeyEnvelope", base64urlEncode(resealed))
                    .put("signature", signVersion(ws, node.id, ctx.versionId, ctx.objectId, suite, resealed)))
            }
            // A grantee whose keys changed by a checked succession is followed first, so their share is sealed to the new keys.
            for (share in entry.shares) {
                val granteeId = share.optString("granteeUserId")
                val pin = pins[granteeId] ?: continue
                if (!ledger.hasShare(node.id, granteeId)) continue
                val served = share.optJSONObject("grantee")?.let { ServedIdentity.from(it) } ?: continue
                if (!pin.matches(served)) followPin(pin, served)?.let { pins[granteeId] = it }
            }
            val plan = planReseal(node.id, entry.shares, entry.links, ledger, pins)
            skipped.addAll(plan.skipped)
            firstKems.putAll(plan.firstKems)
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
            previous[node.id] = node.keyEpoch to old
            nodes.putKey(ws, node.id, fresh)
            epochs[node.id] = target
            batch.put(wire)
        }
        var applied = 0
        if (batch.length() > 0) {
            val outcomes = api.rotateNodes(ws, rootId, batch)
            // A signature the server could not verify is a bug here, not a race: trying again would loop until stuck.
            if (outcomes.any { it.second == "bad-signature" }) throw ApiError(400, "This change was not signed by your keys. Sign in again and retry.")
            applied = outcomes.count { it.second == "ok" || it.second == "already" }
            for ((id, outcome) in outcomes) if (outcome == "ok") sealedIn[id]?.let { seals.record(it) }
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
    // A post-quantum key first vouched for here joins its pin, so a different one later is refused.
    if (firstKems.isNotEmpty()) runCatching { updateSettings { s -> firstKems.forEach { (user, hash) -> s.rememberKem(user, hash) } } }
    return RotationResult(done, skipped.toList())
}
