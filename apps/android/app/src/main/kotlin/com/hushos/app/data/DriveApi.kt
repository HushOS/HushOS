package com.hushos.app.data

import com.hushos.core.ByteRange
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class NotAuthenticated : Exception("Sign in to HushOS to see your files.")
class ApiError(val status: Int, message: String) : Exception(message)
class NotFound(message: String) : Exception(message)
class Unreachable : Exception("Could not reach HushOS. Check your connection.")

/* The Drive API's views, as the server returns them (packages/drive/src/api.ts). */
data class VersionView(
    val id: String, val objectId: String, val contentKeyEnvelope: String, val status: String,
    val contentSuite: UInt, val chunkCount: Int, val contentNonce: String, val plaintextSize: String?,
) {
    companion object {
        fun from(json: JSONObject) = VersionView(
            json.getString("id"), json.getString("objectId"), json.getString("contentKeyEnvelope"), json.getString("status"),
            json.getInt("contentSuite").toUInt(), json.getInt("chunkCount"), json.getString("contentNonce"),
            json.optString("plaintextSize").takeIf { !json.isNull("plaintextSize") },
        )
    }
}

data class NodeView(
    val id: String, val workspaceId: String, val parentId: String?, val kind: String,
    val keyEpoch: ULong, val parentKeyEpoch: ULong, val keyEnvelope: String,
    val metadataVersion: ULong, val metadataEnvelope: String, val currentVersion: VersionView?,
    val trashedAt: String?, val createdAt: String?, val updatedAt: String?, val changeSeq: Int? = null,
    /* The row as the server sent it, for the mirror to keep byte for byte. */
    val rawJson: String = "",
) {
    val isFolder get() = kind == "folder"

    companion object {
        fun from(json: JSONObject) = NodeView(
            json.getString("id"), json.getString("workspaceId"),
            if (json.isNull("parentId")) null else json.getString("parentId"), json.getString("kind"),
            json.getLong("keyEpoch").toULong(), json.getLong("parentKeyEpoch").toULong(), json.getString("keyEnvelope"),
            json.getLong("metadataVersion").toULong(), json.getString("metadataEnvelope"),
            json.optJSONObject("currentVersion")?.let { VersionView.from(it) },
            if (json.isNull("trashedAt")) null else json.getString("trashedAt"),
            json.optString("createdAt").takeIf { it.isNotEmpty() }, json.optString("updatedAt").takeIf { it.isNotEmpty() },
            if (json.isNull("changeSeq")) null else json.optInt("changeSeq"),
            json.toString(),
        )
    }
}

data class GrantView(val json: JSONObject) {
    val grant get() = com.hushos.core.WorkspaceGrant(
        json.getInt("version").toUInt(), json.getString("workspaceId"), json.getLong("keyVersion").toULong(),
        json.getLong("workspaceKeyVersion").toULong(), json.getString("wrappingSalt"), json.getString("wrappingNonce"),
        json.getString("encryptedKey"),
    )
}

data class WorkspaceView(val workspaceId: String, val changeSeq: Int, val grant: GrantView?, val root: NodeView?)
data class Listing(val folder: NodeView, val ancestors: List<NodeView>, val children: List<NodeView>, val nextCursor: String?)
data class TrashEntry(val node: NodeView, val ancestors: List<NodeView>, val parentTrashed: Boolean)
data class TrashListing(val items: List<TrashEntry>, val nextCursor: String?)
data class NodeChange(val kind: String, val changeSeq: Int, val node: NodeView?, val nodeId: String?)
data class ChangeFeed(val changes: List<NodeChange>, val resync: Boolean, val nextCursor: Int, val hasMore: Boolean)
data class PartUrl(val partNumber: Int, val url: String)
data class UploadBegun(val uploadId: String, val parts: List<PartUrl>)
data class VersionListView(
    val id: String, val objectId: String, val contentKeyEnvelope: String, val status: String, val contentSuite: UInt,
    val contentNonce: String, val plaintextSize: String?, val current: Boolean, val createdAt: String,
)
data class StorageBreakdown(val trashBytes: Long, val trashItems: Int, val supersededBytes: Long, val supersededVersions: Int)
data class ShareView(
    val id: String, val workspaceId: String, val role: String, val createdAt: String, val keyEpoch: ULong, val shareEnvelope: String,
    val granterId: String, val granterName: String, val granterEmail: String, val granterPublicKey: String, val node: NodeView,
) {
    val isFolder get() = node.isFolder
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

/* The Drive API over HttpURLConnection with the stored session cookie; every method is one route. */
class DriveApi(val session: Shared.Session) {
    private val origin = session.origin
    private val cookie = (if (origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session") + "=" + session.token

    private fun open(path: String, method: String): HttpURLConnection {
        val connection = URL("$origin/api/drive$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Cookie", cookie)
        connection.setRequestProperty("HushOS-Client", "android/2")
        connection.setRequestProperty("Origin", origin)
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        return connection
    }

    private fun finish(connection: HttpURLConnection): JSONObject {
        val status: Int
        val text: String
        try {
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw Unreachable()
        }
        if (status == 401) throw NotAuthenticated()
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("message") }.getOrNull()
            if (status == 404) throw NotFound(if (message.isNullOrEmpty()) "This item no longer exists." else message)
            throw ApiError(status, if (message.isNullOrEmpty()) "Request failed" else message)
        }
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    private fun get(path: String): JSONObject = finish(open(path, "GET"))

    private fun send(path: String, body: JSONObject, method: String = "POST"): JSONObject {
        val connection = open(path, method)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        return finish(connection)
    }

    private fun q(vararg pairs: Pair<String, String?>) =
        pairs.filter { it.second != null }.joinToString("&", prefix = "?") { "${it.first}=${URLEncoder.encode(it.second, "UTF-8")}" }

    // Reads

    fun workspace(): WorkspaceView = get("/workspace").let {
        WorkspaceView(it.getString("workspaceId"), it.optInt("changeSeq"), it.optJSONObject("grant")?.let { g -> GrantView(g) },
            it.optJSONObject("root")?.let { r -> NodeView.from(r) })
    }

    fun children(nodeId: String, workspaceId: String, after: String?): Listing =
        get("/nodes/$nodeId/children" + q("workspaceId" to workspaceId, "after" to after)).let {
            Listing(NodeView.from(it.getJSONObject("folder")), it.getJSONArray("ancestors").objects().map(NodeView::from),
                it.getJSONArray("children").objects().map(NodeView::from), if (it.isNull("nextCursor")) null else it.getString("nextCursor"))
        }

    fun versionUrl(versionId: String, workspaceId: String): String =
        get("/versions/$versionId/url" + q("workspaceId" to workspaceId)).getString("url")

    fun versions(nodeId: String, workspaceId: String): List<VersionListView> =
        get("/nodes/$nodeId/versions" + q("workspaceId" to workspaceId)).getJSONArray("versions").objects().map {
            VersionListView(it.getString("id"), it.getString("objectId"), it.getString("contentKeyEnvelope"), it.getString("status"),
                it.getInt("contentSuite").toUInt(), it.getString("contentNonce"),
                it.optString("plaintextSize").takeIf { _ -> !it.isNull("plaintextSize") }, it.getBoolean("current"), it.getString("createdAt"))
        }

    fun trashListing(workspaceId: String, after: String?): TrashListing =
        get("/workspaces/$workspaceId/trash" + q("after" to after)).let {
            TrashListing(it.getJSONArray("items").objects().map { e ->
                TrashEntry(NodeView.from(e.getJSONObject("node")), e.getJSONArray("ancestors").objects().map(NodeView::from), e.getBoolean("parentTrashed"))
            }, if (it.isNull("nextCursor")) null else it.getString("nextCursor"))
        }

    fun storage(workspaceId: String): StorageBreakdown = get("/workspaces/$workspaceId/storage").let {
        StorageBreakdown(it.getString("trashBytes").toLong(), it.getInt("trashItems"), it.getString("supersededBytes").toLong(), it.getInt("supersededVersions"))
    }

    fun changes(workspaceId: String, since: Int, limit: Int = 500): ChangeFeed =
        get("/workspaces/$workspaceId/changes" + q("since" to since.toString(), "limit" to limit.toString())).let {
            ChangeFeed(it.getJSONArray("changes").objects().map { c ->
                NodeChange(c.getString("kind"), c.getInt("changeSeq"), c.optJSONObject("node")?.let(NodeView::from), c.optString("nodeId").takeIf { s -> s.isNotEmpty() })
            }, it.optBoolean("resync"), it.getInt("nextCursor"), it.getBoolean("hasMore"))
        }

    /* A workspace document: its envelope and version, or null when none was written yet. */
    fun document(workspaceId: String, kind: String): Pair<String, Int>? =
        get("/workspaces/$workspaceId/documents/$kind").optJSONObject("document")?.let { it.getString("envelope") to it.getInt("version") }

    fun putDocument(workspaceId: String, kind: String, version: Int, envelope: String) {
        send("/workspaces/$workspaceId/documents/$kind", JSONObject().put("version", version).put("envelope", envelope), "PUT")
    }

    fun sharedWithMe(): List<ShareView> = get("/shares").getJSONArray("shares").objects().map {
        val granter = it.getJSONObject("granter")
        ShareView(it.getString("id"), it.getString("workspaceId"), it.getString("role"), it.getString("createdAt"), it.getLong("keyEpoch").toULong(),
            it.getString("shareEnvelope"), granter.getString("id"), granter.optString("name"), granter.optString("email"), granter.getString("encryptionPublicKey"),
            NodeView.from(it.getJSONObject("node")))
    }

    fun links(nodeId: String, workspaceId: String): List<LinkView> =
        get("/nodes/$nodeId/links" + q("workspaceId" to workspaceId)).getJSONArray("links").objects().map(LinkView::from)

    fun createLink(nodeId: String, body: JSONObject): LinkView = LinkView.from(send("/nodes/$nodeId/links", body).getJSONObject("link"))

    fun revokeLink(linkId: String, workspaceId: String) {
        send("/links/$linkId", JSONObject().put("workspaceId", workspaceId), "DELETE")
    }

    fun fileReport(body: JSONObject): Boolean = send("/reports", body).optBoolean("duplicate")

    /* Everything this account shared out, with the nodes still sealed. */
    fun sharedByMe(): Pair<List<Pair<OwnedShare, NodeView>>, List<Pair<LinkView, NodeView>>> = get("/shares/mine").let { json ->
        val shares = json.getJSONArray("shares").objects().map { OwnedShare.from(it) to NodeView.from(it.getJSONObject("node")) }
        val links = json.getJSONArray("links").objects().map { LinkView.from(it) to NodeView.from(it.getJSONObject("node")) }
        shares to links
    }

    fun startRotation(workspaceId: String, nodeId: String): ULong =
        send("/nodes/$nodeId/rotation", JSONObject().put("workspaceId", workspaceId)).getJSONObject("rotation").getLong("targetEpoch").toULong()

    fun rotationWork(workspaceId: String, nodeId: String, after: String?): RotationWork =
        get("/nodes/$nodeId/rotation/work" + q("workspaceId" to workspaceId, "after" to after)).let { json ->
            RotationWork(
                json.getJSONObject("rotation").getLong("targetEpoch").toULong(),
                json.getJSONArray("nodes").objects().map { n ->
                    RotationWorkNode(NodeView.from(n), n.optJSONArray("versions")?.objects().orEmpty(), n.optJSONArray("shares")?.objects().orEmpty(), n.optJSONArray("links")?.objects().orEmpty())
                },
                if (json.isNull("nextCursor")) null else json.getString("nextCursor"),
                json.optBoolean("done"),
            )
        }

    fun rotateNodes(workspaceId: String, nodeId: String, nodes: JSONArray): List<String> =
        send("/nodes/$nodeId/rotation/nodes", JSONObject().put("workspaceId", workspaceId).put("nodes", nodes)).getJSONArray("results").objects().map { it.getString("status") }

    fun shares(nodeId: String, workspaceId: String): List<OwnedShare> =
        get("/nodes/$nodeId/shares" + q("workspaceId" to workspaceId)).getJSONArray("shares").objects().map(OwnedShare::from)

    fun createShare(nodeId: String, body: JSONObject): OwnedShare = OwnedShare.from(send("/nodes/$nodeId/shares", body).getJSONObject("share"))

    fun revokeShare(shareId: String, workspaceId: String) {
        send("/shares/$shareId", JSONObject().put("workspaceId", workspaceId), "DELETE")
    }

    fun thumbnailUrl(versionId: String, workspaceId: String): String? {
        val urls = get("/thumbnails" + q("workspaceId" to workspaceId, "versions" to versionId)).getJSONArray("urls")
        return if (urls.length() > 0) urls.getJSONObject(0).getString("url") else null
    }

    /* One byte range of a stored object, from its presigned URL. */
    fun range(url: String, range: ByteRange): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.setRequestProperty("Range", "bytes=${range.start}-${range.end}")
        connection.connectTimeout = 30_000
        connection.readTimeout = 120_000
        val status = try { connection.responseCode } catch (error: java.io.IOException) { throw Unreachable() }
        if (status != 206 && status != 200) throw ApiError(status, "Range request failed")
        return connection.inputStream.use { it.readBytes() }
    }

    fun putPart(url: String, data: ByteArray): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "PUT"
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(data.size)
        connection.connectTimeout = 30_000
        connection.readTimeout = 300_000
        connection.outputStream.use { it.write(data) }
        val status = connection.responseCode
        if (status !in 200..299) throw ApiError(status, "Part upload failed")
        return connection.getHeaderField("ETag") ?: throw ApiError(500, "The store returned no ETag")
    }

    // Writes

    fun allocateEpoch(workspaceId: String): ULong =
        send("/workspaces/$workspaceId/epochs", JSONObject().put("count", 1)).getLong("from").toULong()

    fun createFolder(workspaceId: String, folder: JSONObject): NodeView =
        NodeView.from(send("/folders", JSONObject().put("workspaceId", workspaceId).put("folders", JSONArray().put(folder))).getJSONArray("nodes").getJSONObject(0))

    fun rename(nodeId: String, workspaceId: String, metadataVersion: ULong, keyEpoch: ULong, metadataEnvelope: String): NodeView =
        NodeView.from(send("/nodes/$nodeId/metadata", JSONObject().put("workspaceId", workspaceId).put("metadataVersion", metadataVersion.toLong())
            .put("keyEpoch", keyEpoch.toLong()).put("metadataEnvelope", metadataEnvelope)).getJSONObject("node"))

    fun move(nodeId: String, workspaceId: String, parentId: String, parentKeyEpoch: ULong, keyEnvelope: String): NodeView =
        NodeView.from(send("/nodes/$nodeId/parent", JSONObject().put("workspaceId", workspaceId).put("parentId", parentId)
            .put("parentKeyEpoch", parentKeyEpoch.toLong()).put("keyEnvelope", keyEnvelope)).getJSONObject("node"))

    fun copy(sourceNodeId: String, workspaceId: String, body: JSONObject): NodeView =
        NodeView.from(send("/nodes/$sourceNodeId/copy", body.put("workspaceId", workspaceId)).getJSONObject("node"))

    fun trash(nodeId: String, workspaceId: String) {
        send("/nodes/$nodeId/trash", JSONObject().put("workspaceId", workspaceId))
    }

    fun restore(nodeId: String, workspaceId: String, toRoot: Pair<ULong, String>?): NodeView {
        val body = JSONObject().put("workspaceId", workspaceId)
        if (toRoot != null) body.put("toRoot", JSONObject().put("parentKeyEpoch", toRoot.first.toLong()).put("keyEnvelope", toRoot.second))
        return NodeView.from(send("/nodes/$nodeId/restore", body).getJSONObject("node"))
    }

    fun purge(nodeId: String, workspaceId: String) {
        send("/nodes/$nodeId", JSONObject().put("workspaceId", workspaceId), "DELETE")
    }

    fun emptyTrash(workspaceId: String) {
        send("/workspaces/$workspaceId/trash/empty", JSONObject())
    }

    fun restoreVersion(versionId: String, workspaceId: String): NodeView =
        NodeView.from(send("/versions/$versionId/restore", JSONObject().put("workspaceId", workspaceId)).getJSONObject("node"))

    fun beginUpload(workspaceId: String, body: JSONObject): UploadBegun = send("/uploads", body.put("workspaceId", workspaceId)).let {
        UploadBegun(it.getJSONObject("upload").getString("id"), it.getJSONArray("parts").objects().map { p -> PartUrl(p.getInt("partNumber"), p.getString("url")) })
    }

    fun partUrls(uploadId: String, workspaceId: String, from: Int): List<PartUrl> =
        get("/uploads/$uploadId/parts" + q("workspaceId" to workspaceId, "from" to from.toString(), "count" to "64"))
            .getJSONArray("parts").objects().map { PartUrl(it.getInt("partNumber"), it.getString("url")) }

    fun completeUpload(uploadId: String, workspaceId: String, parts: JSONArray): NodeView? =
        send("/uploads/$uploadId/complete", JSONObject().put("workspaceId", workspaceId).put("parts", parts)).optJSONObject("node")?.let(NodeView::from)

    fun abortUpload(uploadId: String, workspaceId: String) {
        runCatching { send("/uploads/$uploadId/abort", JSONObject().put("workspaceId", workspaceId)) }
    }
}
