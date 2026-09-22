package com.hushos.app.data

import com.hushos.core.LinkContext
import com.hushos.core.MetadataContext
import com.hushos.core.NodeKeyContext
import com.hushos.core.ShareContext
import com.hushos.core.VersionContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.kemBindingVerify
import com.hushos.core.keyDigest
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

/*
 * Subtree rotation, as the web does it after a share is revoked: every node
 * below the root gets a fresh key at the target epoch, parents first; its
 * metadata, versions, live shares (to keys the pins vouch for) and links are
 * sealed again under it. The server hands out the work in depth order and
 * applies each batch; a node whose parent is not ready yet comes back later.
 */
internal fun Vault.rotateSubtree(item: Opened, progress: (Int) -> Unit): Int {
    val ws = item.node.workspaceId
    val rootId = item.id
    val target = api.startRotation(ws, rootId)
    // The root's chain must be open: its parent key is what the new root key wraps under.
    if (item.isFolder) listChildren(rootId) else item.node.parentId?.let { listChildren(it) }
    val keys = identityKeys()
    val pins = loadSettings().contacts
    val epochs = HashMap<String, ULong>().apply { openedNodes().forEach { (id, opened) -> put(id, opened.node.keyEpoch) } }
    val previous = HashMap<String, Pair<ULong, ByteArray>>()
    var done = 0
    var cursor: String? = null
    var idle = 0

    fun parentKey(parentId: String?, epoch: ULong): ByteArray? {
        if (parentId == null) return workspaceKeyBytes()
        if (epochs[parentId] == epoch) nodeKey(parentId)?.let { return it }
        previous[parentId]?.let { if (it.first == epoch) return it.second }
        return null
    }

    /* The keys a grantee's share is sealed to, by the pin; null drops the share, which keeps its old, soon unopenable envelope. */
    fun trusted(share: JSONObject): Pair<ByteArray, ByteArray?>? {
        val granteeId = share.getString("granteeUserId")
        val served = share.getJSONObject("grantee")
        val pin = pins[granteeId] ?: return null
        if (pin.encryptionPublicKey != served.getString("encryptionPublicKey")) return null
        val publicKey = base64urlDecode(pin.encryptionPublicKey)
        val kem = served.optJSONObject("kem") ?: return if (pin.kemPublicKeyHash == null) publicKey to null else null
        val kemBytes = base64urlDecode(kem.getString("publicKey"))
        val digest = keyDigest(kemBytes)
        pin.kemPublicKeyHash?.let { return if (it == digest) publicKey to kemBytes else null }
        val signed = kemBindingVerify(granteeId, served.getString("encryptionPublicKey"), served.getString("signingPublicKey"), kem.getString("publicKey"), kem.getString("signature"))
        return publicKey to (if (signed) kemBytes else null)
    }

    while (true) {
        val work = api.rotationWork(ws, rootId, cursor)
        if (work.done) break
        if (work.nodes.isEmpty()) {
            cursor = null
            if (++idle > 3) throw RotationStuck()
            continue
        }
        val inBatch = work.nodes.map { it.node.id }.toSet()
        for (parentId in work.nodes.mapNotNull { it.node.parentId }.toSet()) {
            if (parentId !in inBatch && item(parentId) == null) {
                runCatching { listChildren(parentId) }
                item(parentId)?.let { epochs[parentId] = it.node.keyEpoch }
            }
        }
        val batch = JSONArray()
        for (entry in work.nodes) {
            val node = entry.node
            val newParentEpoch = if (node.id == rootId) node.parentKeyEpoch else target
            val wrappedUnder = parentKey(node.parentId, node.parentKeyEpoch) ?: continue
            val wrapUnder = parentKey(node.parentId, newParentEpoch) ?: continue
            val old: ByteArray = (if (epochs[node.id] == node.keyEpoch) nodeKey(node.id) else null)
                ?: nodeOpen(NodeKeyContext(ws, node.id, node.parentId ?: ws, node.parentKeyEpoch, node.keyEpoch), wrappedUnder, base64urlDecode(node.keyEnvelope))
            val wire = JSONObject().put("id", node.id).put("changeSeq", node.changeSeq ?: 0).put("parentKeyEpoch", newParentEpoch.toLong())
            if (node.keyEpoch >= target) {
                // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
                val envelope = nodeWrap(NodeKeyContext(ws, node.id, node.parentId ?: ws, newParentEpoch, node.keyEpoch), wrapUnder, old)
                wire.put("keyEnvelope", base64urlEncode(envelope)).put("rotated", JSONObject.NULL)
                rememberKey(node.id, old)
                epochs[node.id] = node.keyEpoch
                batch.put(wire)
                continue
            }
            val fresh = randomBytes(32u)
            val envelope = nodeWrap(NodeKeyContext(ws, node.id, node.parentId ?: ws, newParentEpoch, target), wrapUnder, fresh)
            val metaCtx = MetadataContext(ws, node.id, node.metadataVersion)
            val metadataEnvelope = metadataSeal(metaCtx, fresh, metadataOpen(metaCtx, old, base64urlDecode(node.metadataEnvelope)))
            val versions = JSONArray()
            for (version in entry.versions) {
                val ctx = VersionContext(ws, node.id, version.getString("id"), version.getString("objectId"))
                val suite = version.getInt("contentSuite").toUInt()
                val rowSize = version.optString("plaintextSize").takeIf { !version.isNull("plaintextSize") }?.toULongOrNull()
                val content = versionOpen(ctx, suite, old, base64urlDecode(version.getString("contentKeyEnvelope")), rowSize)
                versions.put(JSONObject().put("id", version.getString("id")).put("contentKeyEnvelope", base64urlEncode(versionReseal(ctx, suite, fresh, content))))
            }
            val shares = JSONArray()
            for (share in entry.shares) {
                val (publicKey, kem) = trusted(share) ?: continue
                val ctx = ShareContext(ws, node.id, target, share.getString("granteeUserId"), api.session.userId)
                shares.put(JSONObject().put("id", share.getString("id")).put("shareEnvelope", base64urlEncode(shareSeal(ctx, fresh, keys.encryptionPrivateKey, publicKey, kem))))
            }
            val links = JSONArray()
            val unsealable = JSONArray()
            for (link in entry.links) {
                val id = link.getString("id")
                if (link.isNull("secretEnvelope")) { unsealable.put(id); continue }
                val owned = linkSecretOpen(LinkContext(ws, node.id, node.keyEpoch, id), old, base64urlDecode(link.getString("secretEnvelope")))
                // A password link sealed before the password key was kept cannot be re-sealed without the password.
                if (link.getBoolean("hasPassword") && owned.fromPassword == null) { unsealable.put(id); continue }
                val stretched = owned.fromPassword ?: ByteArray(32)
                val newCtx = LinkContext(ws, node.id, target, id)
                links.put(JSONObject().put("id", id)
                    .put("linkEnvelope", base64urlEncode(linkSeal(newCtx, fresh, owned.secret, stretched)))
                    .put("secretEnvelope", base64urlEncode(linkSecretSeal(newCtx, fresh, owned.secret, owned.token, stretched))))
            }
            wire.put("keyEnvelope", base64urlEncode(envelope)).put("rotated", JSONObject()
                .put("metadataEnvelope", base64urlEncode(metadataEnvelope)).put("versions", versions).put("shares", shares)
                .put("links", links).put("unsealableLinks", unsealable))
            // From here the node's key is the fresh one; the old one stays reachable for its unrotated children.
            previous[node.id] = node.keyEpoch to old
            rememberKey(node.id, fresh)
            epochs[node.id] = target
            batch.put(wire)
        }
        var applied = 0
        if (batch.length() > 0) applied = api.rotateNodes(ws, rootId, batch).count { it == "ok" || it == "already" }
        done += applied
        progress(done)
        idle = if (applied > 0) 0 else idle + 1
        if (idle > 3) throw RotationStuck()
        // Everything applied: continue past the batch; otherwise start over so parents come first.
        cursor = if (applied == work.nodes.size) work.nextCursor else null
    }
    // Envelopes changed under every folder: what this device listed is stale.
    forgetAll()
    return done
}
