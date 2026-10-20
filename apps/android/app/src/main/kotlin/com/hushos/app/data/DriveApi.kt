package com.hushos.app.data

import com.hushos.core.ByteRange
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class NotAuthenticated : Exception("Sign in to HushOS to see your files.")
class ApiError(val status: Int, message: String, val code: String? = null) : Exception(message)
class NotFound(message: String) : Exception(message)
class Unreachable : Exception("Could not reach HushOS. Check your connection.")

/*
 * What every request says this client is: its HushOS version (versionName, set by the release pull request),
 * which the server compares with its minimum for `android` (packages/drive's checkClient). Builds before 1.0.0
 * sent the Drive protocol number here ("android/3").
 */
const val CLIENT_HEADER = "android/${com.hushos.app.BuildConfig.VERSION_NAME}"

/*
 * Who the server says wrote a record: an account id alone (round 3). The signature is what this device checks, and a
 * name comes only from this device's own pins (Trust.writer), never from the server.
 */
data class Signer(val id: String) {
    companion object {
        fun from(json: JSONObject?): Signer? = json?.optString("id")?.ifEmpty { null }?.let { Signer(it) }
    }
}

private fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }

/* The Drive API's views, as the server returns them (packages/drive/src/api.ts). */
data class VersionView(
    val id: String, val objectId: String, val contentKeyEnvelope: String, val status: String,
    val contentSuite: UInt, val chunkCount: Int, val contentNonce: String, val plaintextSize: String?,
    /* The account that sealed the content-key envelope and its signature; null before signatures (and the signer on link routes). */
    val signer: Signer? = null, val signature: String? = null,
) {
    companion object {
        fun from(json: JSONObject) = VersionView(
            json.getString("id"), json.getString("objectId"), json.getString("contentKeyEnvelope"), json.getString("status"),
            json.getInt("contentSuite").toUInt(), json.getInt("chunkCount"), json.getString("contentNonce"),
            json.optString("plaintextSize").takeIf { !json.isNull("plaintextSize") },
            Signer.from(json.optJSONObject("signer")), json.nullableString("signature"),
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
    /* How its key and metadata are sealed; rows from before servers said so are suite 1. */
    val envelopeSuite: Int = ENVELOPE_SUITE,
    /* Who wrote the metadata envelope and their signature; null before signatures (and the signer on link routes). */
    val metadataSigner: Signer? = null, val metadataSignature: String? = null,
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
            if (json.isNull("envelopeSuite")) ENVELOPE_SUITE else json.getInt("envelopeSuite"),
            Signer.from(json.optJSONObject("metadataSigner")), json.nullableString("metadataSignature"),
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
data class EmptyTrashResult(val purged: Int, val remaining: Int)
data class TrashListing(val items: List<TrashEntry>, val nextCursor: String?)
data class NodeChange(val kind: String, val changeSeq: Int, val node: NodeView?, val nodeId: String?)
data class ChangeFeed(val changes: List<NodeChange>, val resync: Boolean, val nextCursor: Int, val hasMore: Boolean)
data class PartUrl(val partNumber: Int, val url: String)
data class UploadBegun(val uploadId: String, val parts: List<PartUrl>)
data class VersionListView(
    val id: String, val objectId: String, val contentKeyEnvelope: String, val status: String, val contentSuite: UInt,
    val contentNonce: String, val plaintextSize: String?, val current: Boolean, val createdAt: String,
    /* When a newer version replaced it; the server deletes it 30 days later. */
    val supersededAt: String? = null,
)
data class StorageBreakdown(val trashBytes: Long, val trashItems: Int, val supersededBytes: Long, val supersededVersions: Int)
data class ShareView(
    val id: String, val workspaceId: String, val role: String, val createdAt: String, val keyEpoch: ULong, val shareEnvelope: String,
    val granterId: String, val granterName: String, val granterEmail: String, val node: NodeView,
    /* The granter's identity as served now: the Ed25519 and ML-DSA keys a suite 4 share is checked against (by the pin), and where a succession chain starts. */
    val granter: ServedIdentity,
) {
    val isFolder get() = node.isFolder
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

/* The Drive API over HttpURLConnection with the stored session cookie; every method is one route. */
class DriveApi(val session: Shared.Session) : RootApi {
    private val origin = session.origin
    /*
     * Called when the server could not verify a write's signature against this account's current keys: the
     * identity this device holds is stale (replaced on another device), so it is opened afresh before the next try.
     */
    @Volatile var onBadSignature: () -> Unit = {}
    private val cookie = (if (origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session") + "=" + session.token

    private fun open(path: String, method: String): HttpURLConnection {
        val connection = URL("$origin/api/drive$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Cookie", cookie)
        connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
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
            val body = runCatching { JSONObject(text) }.getOrNull()
            val message = body?.optString("message")
            val code = body?.optString("code")?.ifEmpty { null }
            if (status == 404) throw NotFound(if (message.isNullOrEmpty()) "This item no longer exists." else message)
            if (code == "bad-signature") onBadSignature()
            throw ApiError(status, if (message.isNullOrEmpty()) "Request failed" else message, code)
        }
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    private fun get(path: String): JSONObject = finish(open(path, "GET"))

    private fun send(path: String, body: JSONObject, method: String = "POST"): JSONObject {
        val connection = open(path, method)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        // Writing the body is the first thing to touch the network: no network there is Unreachable too, not
        // a raw "unable to resolve host" for the error dialog.
        try { connection.outputStream.use { it.write(body.toString().toByteArray()) } } catch (error: java.io.IOException) { throw Unreachable() }
        return finish(connection)
    }

    private fun q(vararg pairs: Pair<String, String?>) =
        pairs.filter { it.second != null }.joinToString("&", prefix = "?") { "${it.first}=${URLEncoder.encode(it.second, "UTF-8")}" }

    // Reads

    /* The workspace as the server serves it, so the caller can keep the bytes for a start without network. */
    fun workspaceJson(): JSONObject = get("/workspace")

    fun workspace(json: JSONObject = workspaceJson()): WorkspaceView =
        WorkspaceView(json.getString("workspaceId"), json.optInt("changeSeq"), json.optJSONObject("grant")?.let { g -> GrantView(g) },
            json.optJSONObject("root")?.let { r -> NodeView.from(r) })

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
                it.optString("plaintextSize").takeIf { _ -> !it.isNull("plaintextSize") }, it.getBoolean("current"), it.getString("createdAt"),
                if (it.isNull("supersededAt")) null else it.optString("supersededAt").takeIf { s -> s.isNotEmpty() })
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

    /* A workspace document: its envelope and version, or null when none was written yet; a later suite is refused. */
    fun document(workspaceId: String, kind: String): Pair<String, Int>? =
        get("/workspaces/$workspaceId/documents/$kind").optJSONObject("document")?.let {
            checkSuite(if (it.isNull("envelopeSuite")) ENVELOPE_SUITE else it.getInt("envelopeSuite"))
            it.getString("envelope") to it.getInt("version")
        }

    fun putDocument(workspaceId: String, kind: String, version: Int, envelope: String) {
        send("/workspaces/$workspaceId/documents/$kind", JSONObject().put("version", version).put("envelope", envelope), "PUT")
    }

    fun sharedWithMe(): List<ShareView> = get("/shares").getJSONArray("shares").objects().map {
        val granter = it.getJSONObject("granter")
        ShareView(it.getString("id"), it.getString("workspaceId"), it.getString("role"), it.getString("createdAt"), it.getLong("keyEpoch").toULong(),
            it.getString("shareEnvelope"), granter.getString("id"), granter.optString("name"), granter.optString("email"),
            NodeView.from(it.getJSONObject("node")), ServedIdentity.from(granter))
    }

    fun links(nodeId: String, workspaceId: String): List<LinkView> =
        get("/nodes/$nodeId/links" + q("workspaceId" to workspaceId)).getJSONArray("links").objects().map(LinkView::from)

    fun createLink(nodeId: String, body: JSONObject): LinkView = LinkView.from(send("/nodes/$nodeId/links", body).getJSONObject("link"))

    /* A new password (sealed again on this device) and or end date for a link; its address stays the same. */
    fun updateLink(linkId: String, body: JSONObject): LinkView = LinkView.from(send("/links/$linkId", body, "PATCH").getJSONObject("link"))

    /* Deletes an earlier version for good; the current one cannot be. */
    fun discardVersion(versionId: String, workspaceId: String) {
        send("/versions/$versionId", JSONObject().put("workspaceId", workspaceId), "DELETE")
    }

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

    /* Each node's outcome, by id. */
    fun rotateNodes(workspaceId: String, nodeId: String, nodes: JSONArray): List<Pair<String, String>> =
        send("/nodes/$nodeId/rotation/nodes", JSONObject().put("workspaceId", workspaceId).put("nodes", nodes)).getJSONArray("results").objects().map { it.optString("id") to it.getString("status") }

    fun shares(nodeId: String, workspaceId: String): List<OwnedShare> =
        get("/nodes/$nodeId/shares" + q("workspaceId" to workspaceId)).getJSONArray("shares").objects().map(OwnedShare::from)

    fun createShare(nodeId: String, body: JSONObject): OwnedShare = OwnedShare.from(send("/nodes/$nodeId/shares", body).getJSONObject("share"))

    /* Replaces a live share's envelope at the node's current epoch with a suite 3 one (after this account's keys were replaced). */
    fun resealShare(shareId: String, workspaceId: String, keyEpoch: ULong, envelope: String) {
        send("/shares/$shareId/envelope", JSONObject().put("workspaceId", workspaceId).put("keyEpoch", keyEpoch.toLong()).put("shareEnvelope", envelope), "PUT")
    }

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
        return try { connection.inputStream.use { it.readBytes() } } catch (error: java.io.IOException) { throw Unreachable() }
    }

    fun putPart(url: String, data: ByteArray): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "PUT"
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(data.size)
        connection.connectTimeout = 30_000
        connection.readTimeout = 300_000
        // A connection that drops mid-part is the network's doing: say so, so the part is sent again.
        val status = try { connection.outputStream.use { it.write(data) }; connection.responseCode } catch (error: java.io.IOException) { throw Unreachable() }
        if (status !in 200..299) throw ApiError(status, "Part upload failed")
        return connection.getHeaderField("ETag") ?: throw ApiError(500, "The store returned no ETag")
    }

    // Writes

    override fun allocateEpoch(workspaceId: String): ULong =
        send("/workspaces/$workspaceId/epochs", JSONObject().put("count", 1)).getLong("from").toULong()

    override fun createRoot(workspaceId: String, root: RootInput): NodeView =
        NodeView.from(send("/workspaces/$workspaceId/root", root.body()).getJSONObject("root"))

    fun createFolder(workspaceId: String, folder: JSONObject): NodeView =
        NodeView.from(send("/folders", JSONObject().put("workspaceId", workspaceId).put("folders", JSONArray().put(folder))).getJSONArray("nodes").getJSONObject(0))

    /* `metadataSignature` is over `metadataVersion + 1`, the version the server stores. */
    fun rename(nodeId: String, workspaceId: String, metadataVersion: ULong, keyEpoch: ULong, metadataEnvelope: String, metadataSignature: String): NodeView =
        NodeView.from(send("/nodes/$nodeId/metadata", JSONObject().put("workspaceId", workspaceId).put("metadataVersion", metadataVersion.toLong())
            .put("keyEpoch", keyEpoch.toLong()).put("metadataEnvelope", metadataEnvelope).put("metadataSignature", metadataSignature)).getJSONObject("node"))

    fun move(nodeId: String, workspaceId: String, parentId: String, parentKeyEpoch: ULong, keyEnvelope: String): NodeView =
        NodeView.from(send("/nodes/$nodeId/parent", JSONObject().put("workspaceId", workspaceId).put("parentId", parentId)
            .put("parentKeyEpoch", parentKeyEpoch.toLong()).put("keyEnvelope", keyEnvelope)).getJSONObject("node"))

    fun copy(sourceNodeId: String, workspaceId: String, body: JSONObject): NodeView =
        NodeView.from(send("/nodes/$sourceNodeId/copy", body.put("workspaceId", workspaceId)).getJSONObject("node"))

    /* One request of a selection to the trash, or back in place (Undo): up to MAX_TRASH_BATCH ids of one workspace. */
    fun trashBatch(workspaceId: String, ids: List<String>): List<BatchAnswer> = batch("/workspaces/$workspaceId/trash-batch", ids)
    fun restoreBatch(workspaceId: String, ids: List<String>): List<BatchAnswer> = batch("/workspaces/$workspaceId/restore-batch", ids)

    private fun batch(path: String, ids: List<String>): List<BatchAnswer> {
        val connection = open(path, "POST")
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        val body = JSONObject().put("nodeIds", org.json.JSONArray(ids)).toString().toByteArray()
        try { connection.outputStream.use { it.write(body) } } catch (error: java.io.IOException) { throw Unreachable() }
        val status: Int
        val text: String
        try {
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            // Sent and no answer: what moved isn't known, as for any lost response.
            throw Unreachable()
        }
        return batchAnswers(status, text)
    }

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

    /* One batch of the trash, as the server takes it; `remaining` says whether to ask again. */
    fun emptyTrash(workspaceId: String): EmptyTrashResult =
        send("/workspaces/$workspaceId/trash/empty", JSONObject()).let { EmptyTrashResult(it.getInt("purged"), it.getInt("remaining")) }

    /* Removes every file's earlier version now, a batch at a time; the same shape as emptying the trash. */
    fun discardSuperseded(workspaceId: String): EmptyTrashResult =
        send("/workspaces/$workspaceId/versions/discard-superseded", JSONObject()).let { EmptyTrashResult(it.optInt("purged"), it.optInt("remaining")) }

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
