package com.hushos.files

import android.content.Context
import com.hushos.crypto.HushOSCryptoJNI
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

class CryptoFailure(message: String) : Exception(message)

/* JSON in, JSON out through the Rust core; an error envelope becomes an exception. */
object Crypto {
    fun call(operation: String, params: JSONObject): JSONObject {
        val envelope = JSONObject(HushOSCryptoJNI.call(operation, params.toString()))
        if (envelope.has("error")) throw CryptoFailure(envelope.getString("error"))
        return envelope.optJSONObject("ok") ?: throw CryptoFailure("the crypto core returned no result")
    }

    fun random(length: Int): String = call("random.bytes", JSONObject().put("length", length)).getString("bytes")

    fun decodeBase64Url(value: String): ByteArray =
        android.util.Base64.decode(value, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)

    const val CHUNK_SIZE = 8L * 1024 * 1024
    const val TAG_BYTES = 16L
    fun chunkCount(size: Long): Long = maxOf(1L, (size + CHUNK_SIZE - 1) / CHUNK_SIZE)
    fun chunkLength(size: Long, index: Long): Long {
        val start = index * CHUNK_SIZE
        return if (start >= size) 0 else minOf(CHUNK_SIZE, size - start)
    }
}

data class Metadata(val name: String, val mime: String?, val size: Long?, val modified: String?)
data class Opened(val node: JSONObject, val metadata: Metadata) {
    val id: String get() = node.getString("id")
    val kind: String get() = node.getString("kind")
    val parentId: String? get() = if (node.isNull("parentId")) null else node.getString("parentId")
    val workspaceId: String get() = node.getString("workspaceId")
    val keyEpoch: Int get() = node.getInt("keyEpoch")
    val metadataVersion: Int get() = node.getInt("metadataVersion")
    val currentVersion: JSONObject? get() = node.optJSONObject("currentVersion")
}

/*
 * The keys, opened on demand and kept while the provider lives: the account key
 * from the remembered device, the workspace key from the grant, node keys under
 * their parents. A node-to-parent index persists so a document id the system
 * asks about cold is found by listing the folder it was last seen in.
 */
class Vault(private val context: Context, val api: DriveApi, private val userId: String) {
    private var accountKey: String? = null
    private var workspace: JSONObject? = null
    private var workspaceKey: String? = null
    private val nodeKeys = HashMap<String, String>()
    private val opened = HashMap<String, Opened>()
    private val indexFile = File(context.filesDir, "files-parents.json")
    private val parents: HashMap<String, String> = HashMap<String, String>().also { map ->
        runCatching {
            val json = JSONObject(indexFile.readText())
            for (key in json.keys()) map[key] = json.getString(key)
        }
    }

    private fun saveIndex() {
        val json = JSONObject()
        for ((k, v) in parents) json.put(k, v)
        runCatching { indexFile.writeText(json.toString()) }
    }

    private fun unlockAccount(): String {
        accountKey?.let { return it }
        val device = Shared.read(context, Shared.DEVICE) ?: throw NotAuthenticated()
        val key = Crypto.call("device.restore", JSONObject().put("bundle", device.getJSONObject("bundle")).put("deviceKey", device.getString("deviceKey")))
            .getString("accountKey")
        accountKey = key
        return key
    }

    @Synchronized
    fun loadWorkspace(): JSONObject {
        workspace?.let { return it }
        val view = api.workspace()
        val grant = view.optJSONObject("grant") ?: throw ApiError(404, "No workspace grant")
        val account = unlockAccount()
        workspaceKey = Crypto.call("workspace.open", JSONObject().put("userId", userId).put("accountKey", account).put("grant", grant))
            .getString("workspaceKey")
        workspace = view
        return view
    }

    val rootId: String get() = loadWorkspace().getJSONObject("root").getString("id")
    val workspaceId: String get() = loadWorkspace().getString("workspaceId")

    fun nodeKey(id: String): String? = nodeKeys[id]
    fun item(id: String): Opened? = opened[id]

    private fun parentKeyFor(node: JSONObject): String {
        val parentId = if (node.isNull("parentId")) node.getString("workspaceId") else node.getString("parentId")
        if (parentId == node.getString("workspaceId")) return workspaceKey ?: throw ApiError(500, "Workspace not opened")
        return nodeKeys[parentId] ?: throw ApiError(500, "Open the containing folder first.")
    }

    @Synchronized
    fun open(node: JSONObject): Opened {
        val id = node.getString("id")
        opened[id]?.let { return it }
        val parentId = if (node.isNull("parentId")) node.getString("workspaceId") else node.getString("parentId")
        val key = Crypto.call("node.open", JSONObject()
            .put("workspaceId", node.getString("workspaceId")).put("nodeId", id).put("parentId", parentId)
            .put("parentKeyEpoch", node.getInt("parentKeyEpoch")).put("keyEpoch", node.getInt("keyEpoch"))
            .put("parentKey", parentKeyFor(node)).put("keyEnvelope", node.getString("keyEnvelope"))).getString("nodeKey")
        nodeKeys[id] = key
        val meta = Crypto.call("metadata.open", JSONObject()
            .put("workspaceId", node.getString("workspaceId")).put("nodeId", id)
            .put("metadataVersion", node.getInt("metadataVersion")).put("nodeKey", key)
            .put("envelope", node.getString("metadataEnvelope"))).getJSONObject("metadata")
        val metadata = Metadata(
            meta.getString("name"),
            if (meta.isNull("mime")) null else meta.getString("mime"),
            if (meta.isNull("size")) null else meta.getLong("size"),
            if (meta.isNull("modified")) null else meta.getString("modified"),
        )
        val result = Opened(node, metadata)
        opened[id] = result
        if (!node.isNull("parentId")) parents[id] = node.getString("parentId")
        return result
    }

    fun adopt(node: JSONObject, key: String, metadata: Metadata): Opened {
        val id = node.getString("id")
        nodeKeys[id] = key
        val result = Opened(node, metadata)
        opened[id] = result
        if (!node.isNull("parentId")) parents[id] = node.getString("parentId")
        saveIndex()
        return result
    }

    fun forget(id: String) {
        opened.remove(id)
    }

    /* Every page of a folder, every key along the way opened; parents first. */
    fun listChildren(folderId: String): List<Opened> {
        val ws = workspaceId
        var after: String? = null
        val children = ArrayList<Opened>()
        do {
            val page = api.children(folderId, ws, after)
            val ancestors = page.getJSONArray("ancestors")
            for (i in 0 until ancestors.length()) open(ancestors.getJSONObject(i))
            open(page.getJSONObject("folder"))
            val list = page.getJSONArray("children")
            for (i in 0 until list.length()) {
                val child = list.getJSONObject(i)
                children.add(open(child))
                parents[child.getString("id")] = folderId
            }
            after = if (page.isNull("nextCursor")) null else page.getString("nextCursor")
        } while (after != null)
        saveIndex()
        return children
    }

    fun resolve(id: String): Opened {
        opened[id]?.let { return it }
        if (id == rootId) listChildren(id) else parents[id]?.let { listChildren(it) }
            ?: throw ApiError(500, "This item has not been seen yet; open its folder first.")
        return opened[id] ?: throw ApiError(404, "This item no longer exists.")
    }

    data class OpenedVersion(val contentKey: ByteArray, val nonce: ByteArray, val plaintextSize: Long, val thumbnailBytes: Int, val suite: Int, val objectId: String, val versionId: String)

    fun openVersion(item: Opened): OpenedVersion {
        val version = item.currentVersion ?: throw ApiError(404, "This file has no content yet")
        val key = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val params = JSONObject().put("workspaceId", item.workspaceId).put("nodeId", item.id)
            .put("versionId", version.getString("id")).put("objectId", version.getString("objectId"))
            .put("suite", version.getInt("contentSuite")).put("nodeKey", key).put("envelope", version.getString("contentKeyEnvelope"))
        if (!version.isNull("plaintextSize")) params.put("plaintextSize", version.getString("plaintextSize").toLong())
        val result = Crypto.call("version.open", params)
        return OpenedVersion(
            Crypto.decodeBase64Url(result.getString("contentKey")), Crypto.decodeBase64Url(version.getString("contentNonce")),
            result.getLong("plaintextSize"), result.getInt("thumbnailBytes"), version.getInt("contentSuite"),
            version.getString("objectId"), version.getString("id"),
        )
    }

    /* Downloads and decrypts a file's current version into `destination`. */
    fun download(id: String, destination: File) {
        val item = resolve(id)
        val v = openVersion(item)
        val url = api.versionUrl(v.versionId, item.workspaceId)
        val count = Crypto.chunkCount(v.plaintextSize)
        destination.outputStream().use { out ->
            for (index in 0 until count) {
                val plain = Crypto.chunkLength(v.plaintextSize, index)
                val from = index * (Crypto.CHUNK_SIZE + Crypto.TAG_BYTES)
                val ciphertext = api.range(url, from, from + plain + Crypto.TAG_BYTES - 1)
                val plaintext = HushOSCryptoJNI.decryptChunk(v.contentKey, v.nonce, index, count, v.plaintextSize, v.thumbnailBytes, v.suite, item.workspaceId, v.objectId, ciphertext)
                    ?: throw CryptoFailure("This file could not be decrypted. It may be damaged.")
                out.write(plaintext)
            }
        }
    }

    fun thumbnail(id: String): ByteArray? {
        val item = resolve(id)
        val v = openVersion(item)
        if (v.thumbnailBytes <= 0) return null
        val url = api.thumbnailUrl(v.versionId, item.workspaceId) ?: return null
        val count = Crypto.chunkCount(v.plaintextSize)
        val start = v.plaintextSize + Crypto.TAG_BYTES * count
        val ciphertext = api.range(url, start, start + v.thumbnailBytes + Crypto.TAG_BYTES - 1)
        return HushOSCryptoJNI.decryptChunk(v.contentKey, v.nonce, count, count, v.plaintextSize, v.thumbnailBytes, v.suite, item.workspaceId, v.objectId, ciphertext)
    }

    fun createFolder(parentId: String, name: String): Opened {
        val ws = workspaceId
        val parent = resolve(parentId)
        val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
        val epoch = api.allocateEpochs(ws, 1)
        val id = UUID.randomUUID().toString()
        val key = Crypto.random(32)
        val wrapped = Crypto.call("node.wrap", JSONObject().put("workspaceId", ws).put("nodeId", id).put("parentId", parent.id)
            .put("parentKeyEpoch", parent.keyEpoch).put("keyEpoch", epoch).put("parentKey", parentKey).put("nodeKey", key)).getString("keyEnvelope")
        val sealed = Crypto.call("metadata.seal", JSONObject().put("workspaceId", ws).put("nodeId", id).put("metadataVersion", 1)
            .put("nodeKey", key).put("metadata", JSONObject().put("name", name).put("mime", JSONObject.NULL).put("size", JSONObject.NULL).put("modified", JSONObject.NULL)))
            .getString("metadataEnvelope")
        val node = api.createFolder(ws, JSONObject().put("id", id).put("parentId", parent.id).put("keyEpoch", epoch)
            .put("parentKeyEpoch", parent.keyEpoch).put("keyEnvelope", wrapped).put("metadataEnvelope", sealed))
        return adopt(node, key, Metadata(name, null, null, null))
    }

    fun rename(id: String, name: String): Opened {
        val item = resolve(id)
        val key = nodeKeys[id] ?: throw ApiError(500, "Node not opened")
        val metadata = JSONObject().put("name", name).put("mime", item.metadata.mime ?: JSONObject.NULL)
            .put("size", item.metadata.size ?: JSONObject.NULL).put("modified", item.metadata.modified ?: JSONObject.NULL)
        val sealed = Crypto.call("metadata.seal", JSONObject().put("workspaceId", item.workspaceId).put("nodeId", id)
            .put("metadataVersion", item.metadataVersion + 1).put("nodeKey", key).put("metadata", metadata)).getString("metadataEnvelope")
        val node = api.rename(id, item.workspaceId, item.metadataVersion, item.keyEpoch, sealed)
        return adopt(node, key, item.metadata.copy(name = name))
    }

    fun move(id: String, parentId: String): Opened {
        val item = resolve(id)
        val parent = resolve(parentId)
        val key = nodeKeys[id] ?: throw ApiError(500, "Node not opened")
        val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
        val wrapped = Crypto.call("node.wrap", JSONObject().put("workspaceId", item.workspaceId).put("nodeId", id).put("parentId", parent.id)
            .put("parentKeyEpoch", parent.keyEpoch).put("keyEpoch", item.keyEpoch).put("parentKey", parentKey).put("nodeKey", key)).getString("keyEnvelope")
        val node = api.move(id, item.workspaceId, parent.id, parent.keyEpoch, wrapped)
        return adopt(node, key, item.metadata)
    }

    fun trash(id: String) {
        val item = resolve(id)
        api.trash(id, item.workspaceId)
        forget(id)
    }

    /* A file's bytes as a new node under `parentId`, or a new version of `replacing`. */
    fun upload(file: File, name: String, mime: String?, parentId: String, replacing: Opened?): Opened {
        val ws = workspaceId
        val size = file.length()
        val modified = java.time.Instant.ofEpochMilli(file.lastModified()).toString()
        val versionId = UUID.randomUUID().toString()
        val objectId = UUID.randomUUID().toString()
        val contentKey = Crypto.random(32)
        val contentNonce = Crypto.random(16)
        val nodeId: String
        val nodeKey: String
        val nodeInput: JSONObject
        val metadata: Metadata
        if (replacing != null) {
            nodeId = replacing.id
            nodeKey = nodeKeys[nodeId] ?: throw ApiError(500, "Node not opened")
            nodeInput = JSONObject().put("existing", true).put("id", nodeId).put("keyEpoch", replacing.keyEpoch)
                .put("expectedVersionId", replacing.currentVersion?.getString("id") ?: JSONObject.NULL)
            metadata = replacing.metadata
        } else {
            val parent = resolve(parentId)
            val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
            val epoch = api.allocateEpochs(ws, 1)
            nodeId = UUID.randomUUID().toString()
            nodeKey = Crypto.random(32)
            val wrapped = Crypto.call("node.wrap", JSONObject().put("workspaceId", ws).put("nodeId", nodeId).put("parentId", parent.id)
                .put("parentKeyEpoch", parent.keyEpoch).put("keyEpoch", epoch).put("parentKey", parentKey).put("nodeKey", nodeKey)).getString("keyEnvelope")
            metadata = Metadata(name, mime, size, modified)
            val sealed = Crypto.call("metadata.seal", JSONObject().put("workspaceId", ws).put("nodeId", nodeId).put("metadataVersion", 1).put("nodeKey", nodeKey)
                .put("metadata", JSONObject().put("name", name).put("mime", mime ?: JSONObject.NULL).put("size", size).put("modified", modified))).getString("metadataEnvelope")
            nodeInput = JSONObject().put("existing", false).put("id", nodeId).put("parentId", parent.id).put("keyEpoch", epoch)
                .put("parentKeyEpoch", parent.keyEpoch).put("keyEnvelope", wrapped).put("metadataEnvelope", sealed)
        }
        val version = Crypto.call("version.seal", JSONObject().put("workspaceId", ws).put("nodeId", nodeId).put("versionId", versionId)
            .put("objectId", objectId).put("nodeKey", nodeKey).put("contentKey", contentKey).put("plaintextSize", size).put("thumbnailBytes", 0))
        val chunkCount = version.getLong("chunkCount")
        val begun = api.beginUpload(ws, JSONObject().put("node", nodeInput).put("versionId", versionId).put("objectId", objectId)
            .put("contentKeyEnvelope", version.getString("contentKeyEnvelope")).put("contentNonce", contentNonce)
            .put("contentSuite", 2).put("chunkCount", chunkCount).put("ciphertextSize", version.getLong("ciphertextSize").toString()))
        val uploadId = begun.getJSONObject("upload").getString("id")
        val urls = HashMap<Int, String>()
        val parts = begun.getJSONArray("parts")
        for (i in 0 until parts.length()) urls[parts.getJSONObject(i).getInt("partNumber")] = parts.getJSONObject(i).getString("url")
        val keyBytes = Crypto.decodeBase64Url(contentKey)
        val nonceBytes = Crypto.decodeBase64Url(contentNonce)
        val etags = JSONArray()
        try {
            RandomAccessFile(file, "r").use { raf ->
                for (index in 0 until chunkCount) {
                    val partNumber = index.toInt() + 1
                    if (!urls.containsKey(partNumber)) {
                        val more = api.partUrls(uploadId, ws, partNumber)
                        for (i in 0 until more.length()) urls[more.getJSONObject(i).getInt("partNumber")] = more.getJSONObject(i).getString("url")
                    }
                    val length = Crypto.chunkLength(size, index).toInt()
                    val plaintext = ByteArray(length)
                    raf.seek(index * Crypto.CHUNK_SIZE)
                    raf.readFully(plaintext)
                    val sealed = HushOSCryptoJNI.encryptChunk(keyBytes, nonceBytes, index, chunkCount, size, 2, ws, objectId, plaintext)
                        ?: throw CryptoFailure("This file could not be encrypted.")
                    val etag = api.putPart(urls[partNumber] ?: throw ApiError(500, "No URL for part $partNumber"), sealed)
                    etags.put(JSONObject().put("partNumber", partNumber).put("etag", etag))
                }
            }
        } catch (error: Exception) {
            api.abortUpload(uploadId, ws)
            throw error
        }
        val completed = api.completeUpload(uploadId, ws, etags)
        val node = completed.optJSONObject("node") ?: throw ApiError(500, "Upload completed without a node")
        return adopt(node, nodeKey, metadata)
    }
}
