package com.hushos.app.data

import com.hushos.core.ByteRange
import com.hushos.core.Content
import com.hushos.core.LinkContext
import com.hushos.core.MetadataContext
import com.hushos.core.NodeKeyContext
import com.hushos.core.OperatorKem
import com.hushos.core.OperatorKeys
import com.hushos.core.ReportContext
import com.hushos.core.VersionContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.chunkDecrypt
import com.hushos.core.chunkRange
import com.hushos.core.linkKdfVersion
import com.hushos.core.linkOpen
import com.hushos.core.linkParse
import com.hushos.core.metadataOpen
import com.hushos.core.nodeOpen
import com.hushos.core.reportSealKey
import com.hushos.core.thumbnailDecrypt
import com.hushos.core.thumbnailRange
import com.hushos.core.versionOpen
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/* A link as the owner sees it: what `GET /api/drive/nodes/:id/links` lists. */
data class LinkView(
    val id: String, val keyEpoch: ULong, val secretEnvelope: String?, val hasPassword: Boolean,
    val expiresAt: String?, val useCount: Int, val lastUsedAt: String?, val createdAt: String,
    /* How the link's key is derived; null when the server didn't say, which counts as older than any this app reads. */
    val kdfVersion: Int? = null,
) {
    /* Whether this app can show, open or reseal it: only a link made with the derivation the core speaks now. */
    val current: Boolean get() = LinkKdf.current(kdfVersion)

    companion object {
        fun from(json: JSONObject) = LinkView(
            json.getString("id"), json.getLong("keyEpoch").toULong(),
            if (json.isNull("secretEnvelope")) null else json.getString("secretEnvelope"), json.getBoolean("hasPassword"),
            if (json.isNull("expiresAt")) null else json.getString("expiresAt"), json.optInt("useCount"),
            if (json.isNull("lastUsedAt")) null else json.getString("lastUsedAt"), json.getString("createdAt"),
            if (json.isNull("kdfVersion")) null else json.getInt("kdfVersion"),
        )
    }
}

class OldLink : Refused("Ask for a new link", "This link was made by an older version of HushOS. Ask for a new link.")

/*
 * A link's key derivation, as the server records it. A link made with an older one (argon2id
 * settings since raised, or a password shorter than links now take) is neither opened, shown
 * nor sealed again here: the owner turns it off and makes a new one.
 */
object LinkKdf {
    /* At least this many characters in a link password; the core refuses shorter ones too. */
    const val MIN_PASSWORD = 8

    fun current(kdfVersion: Int?, supported: Int = linkKdfVersion().toInt()) = kdfVersion == supported

    fun check(kdfVersion: Int?, supported: Int = linkKdfVersion().toInt()) {
        if (!current(kdfVersion, supported)) throw OldLink()
    }
}

/* What the server hands a visitor for a token: enough to open the root with the fragment secret. */
data class OpenedLink(
    val id: String, val workspaceId: String, val keyEpoch: ULong, val hasPassword: Boolean,
    val linkSalt: String, val linkEnvelope: String, val expiresAt: String?, val node: NodeView,
    val kdfVersion: Int? = null,
)

/* An operator as `GET /api/drive/reports/operators` lists them. */
data class ReportOperator(val userId: String, val encryptionPublicKey: String, val signingPublicKey: String, val kem: OperatorKem?)

object Reports {
    /* What can be reported, in the words the web uses. */
    val categories = listOf(
        "csam" to "Child sexual abuse material",
        "terrorism" to "Terrorist content",
        "ncii" to "Intimate images shared without consent",
        "malware" to "Malware",
        "copyright" to "Copyright infringement",
        "harassment" to "Harassment",
        "other" to "Something else",
    )

    /*
     * The report body: the node key sealed to every operator with the
     * report's context bound in, so the server, holding public keys only,
     * cannot open it, and an operator can open only this report.
     */
    fun body(operators: List<ReportOperator>, item: Opened, nodeKey: ByteArray, category: String, reason: String, email: String?, via: JSONObject): JSONObject {
        if (operators.isEmpty()) throw ApiError(503, "This HushOS has no operators to report to.")
        val reportId = UUID.randomUUID().toString()
        val keys = JSONArray()
        for (operator in operators) {
            val ctx = ReportContext(item.node.workspaceId, item.id, item.node.keyEpoch, reportId, operator.userId)
            val sealed = reportSealKey(ctx, nodeKey, OperatorKeys(operator.userId, operator.encryptionPublicKey, operator.signingPublicKey, operator.kem))
            keys.put(JSONObject().put("operatorUserId", operator.userId).put("keyEnvelope", base64urlEncode(sealed)))
        }
        val trimmed = email?.trim().orEmpty()
        return JSONObject().put("id", reportId).put("workspaceId", item.node.workspaceId).put("nodeId", item.id)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("category", category).put("reason", reason).put("via", via)
            .put("reporterEmail", if (trimmed.isEmpty()) JSONObject.NULL else trimmed).put("keys", keys)
    }
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

/*
 * The routes that need no session: what a visitor with a link, or anyone filing a report on a link,
 * talks to. No Cookie header is set here, and the app installs no CookieHandler, so nothing of a
 * signed-in session rides along: a visitor stays anonymous even on a phone that is signed in.
 */
class PublicApi(val origin: String) {
    private fun open(path: String, method: String): HttpURLConnection {
        val connection = URL("$origin/api/drive$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
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
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("message") }.getOrNull()
            if (status == 404) throw NotFound(if (message.isNullOrEmpty()) "This link no longer works." else message)
            throw ApiError(status, if (message.isNullOrEmpty()) "Request failed" else message)
        }
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    private fun get(path: String): JSONObject = finish(open(path, "GET"))

    fun post(path: String, body: JSONObject): JSONObject {
        val connection = open(path, "POST")
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        return finish(connection)
    }

    fun openLink(token: String): OpenedLink = get("/links/$token/open").let {
        val link = it.getJSONObject("link")
        OpenedLink(link.getString("id"), link.getString("workspaceId"), link.getLong("keyEpoch").toULong(), link.getBoolean("hasPassword"),
            link.getString("linkSalt"), link.getString("linkEnvelope"), if (link.isNull("expiresAt")) null else link.getString("expiresAt"),
            NodeView.from(it.getJSONObject("node")), if (link.isNull("kdfVersion")) null else link.getInt("kdfVersion"))
    }

    fun linkChildren(token: String, nodeId: String, after: String?): Listing =
        get("/links/$token/nodes/$nodeId/children" + (after?.let { "?after=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")).let {
            Listing(NodeView.from(it.getJSONObject("folder")), it.getJSONArray("ancestors").objects().map(NodeView::from),
                it.getJSONArray("children").objects().map(NodeView::from), if (it.isNull("nextCursor")) null else it.getString("nextCursor"))
        }

    fun linkVersionUrl(token: String, versionId: String): String = get("/links/$token/versions/$versionId/url").getString("url")

    fun linkThumbnailUrl(token: String, versionId: String): String? {
        val urls = get("/links/$token/thumbnails?versions=$versionId").getJSONArray("urls")
        return if (urls.length() > 0) urls.getJSONObject(0).getString("url") else null
    }

    fun operators(): List<ReportOperator> = get("/reports/operators").getJSONArray("operators").objects().map {
        ReportOperator(it.getString("userId"), it.getString("encryptionPublicKey"), it.getString("signingPublicKey"),
            it.optJSONObject("kem")?.let { kem -> OperatorKem(kem.getString("publicKey"), kem.getString("signature")) })
    }

    fun range(url: String, range: ByteRange): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.setRequestProperty("Range", "bytes=${range.start}-${range.end}")
        connection.connectTimeout = 30_000
        connection.readTimeout = 120_000
        val status = try { connection.responseCode } catch (error: java.io.IOException) { throw Unreachable() }
        if (status != 206 && status != 200) throw ApiError(status, "Range request failed")
        return connection.inputStream.use { it.readBytes() }
    }
}

/*
 * A visitor's view through one link: the root opened with the fragment secret
 * (and the password when the link has one), every node below it under the
 * usual node keys, and content by the link's own download routes. Its keys stay
 * in its own maps, keyed by workspace and node like the Vault's, and never reach
 * the signed-in account's Vault.
 */
class LinkVault(origin: String, url: String) {
    val api = PublicApi(origin)
    val token: String
    private val secret: String
    private var link: OpenedLink? = null
    private val nodes = NodeCache { link?.workspaceId }

    init {
        val parts = linkParse(url)
        token = parts.token
        secret = parts.secret
    }

    /* A link made with an older key derivation is refused before anything is derived from it. */
    private fun load(): OpenedLink = link ?: api.openLink(token).also {
        LinkKdf.check(it.kdfVersion)
        checkSuite(it.node.envelopeSuite)
        if (it.node.workspaceId != it.workspaceId) throw ApiError(502, "This link does not match its item.")
        link = it
    }

    fun needsPassword(): Boolean = load().hasPassword

    /* Opens the root: the node key from the secret and password, then its name. */
    fun open(password: String?): Opened {
        val fetched = load()
        val ctx = LinkContext(fetched.workspaceId, fetched.node.id, fetched.keyEpoch, fetched.id)
        val key = linkOpen(ctx, base64urlDecode(fetched.linkEnvelope), base64urlDecode(secret), password, base64urlDecode(fetched.linkSalt))
        val node = fetched.node
        val metadata = metadataOpen(MetadataContext(node.workspaceId, node.id, node.metadataVersion), key, base64urlDecode(node.metadataEnvelope))
        return openedRow(node, metadata, key).also { nodes.put(it, key) }
    }

    private fun open(node: NodeView): Opened {
        checkSuite(node.envelopeSuite)
        // Everything below the root is in the link's workspace; a row naming another is not this link's.
        val ws = load().workspaceId
        if (node.workspaceId != ws) throw ApiError(500, "This item is outside the link.")
        nodes.row(ws, node.id)?.let { return it }
        val parentId = node.parentId ?: throw ApiError(500, "This item is outside the link.")
        val parentKey = nodes.key(ws, parentId) ?: throw ApiError(500, "This item is outside the link.")
        val key = nodeOpen(NodeKeyContext(node.workspaceId, node.id, parentId, node.parentKeyEpoch, node.keyEpoch), parentKey, base64urlDecode(node.keyEnvelope))
        val metadata = metadataOpen(MetadataContext(node.workspaceId, node.id, node.metadataVersion), key, base64urlDecode(node.metadataEnvelope))
        return openedRow(node, metadata, key).also { nodes.put(it, key) }
    }

    fun children(folderId: String): List<Opened> {
        var after: String? = null
        val all = ArrayList<Opened>()
        do {
            val page = api.linkChildren(token, folderId, after)
            // A row in a later format stays out of the list; anything else wrong with one fails the folder, as before.
            page.children.forEach { child -> runCatching { open(child) }.onSuccess { all.add(it) }.onFailure { if (it !is NewerFormat) throw it } }
            after = page.nextCursor
        } while (after != null)
        return all.sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    private fun openVersion(item: Opened): OpenedVersion {
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val current = item.node.currentVersion ?: throw NotFound("This file has no content yet.")
        val v = versionOpen(VersionContext(item.node.workspaceId, item.id, current.id, current.objectId), current.contentSuite, key,
            base64urlDecode(current.contentKeyEnvelope), current.plaintextSize?.toULongOrNull())
        return OpenedVersion(Content(item.node.workspaceId, current.objectId, current.contentSuite, v.key, base64urlDecode(current.contentNonce), v.plaintextSize, v.thumbnailBytes), current.id)
    }

    fun download(item: Opened, destination: File, progress: (Float) -> Unit = {}) {
        val v = openVersion(item)
        var url = api.linkVersionUrl(token, v.versionId)
        // Resumable like the drive's own downloads: a dropped chunk is fetched again, a `.part` is continued.
        Resumable.download(destination, v.layout.chunkCount, v.layout.chunkBytes.toLong(), progress = progress,
            onExpired = { url = api.linkVersionUrl(token, v.versionId) },
        ) { index -> chunkDecrypt(v.content, index, api.range(url, chunkRange(v.content.suite, v.content.plaintextSize, v.content.thumbnailBytes, index))) }
    }

    fun thumbnail(item: Opened): ByteArray? {
        if (!item.hasThumbnail) return null
        val v = openVersion(item)
        if (v.content.thumbnailBytes == 0u) return null
        val url = api.linkThumbnailUrl(token, v.versionId) ?: return null
        return thumbnailDecrypt(v.content, api.range(url, thumbnailRange(v.content.suite, v.content.plaintextSize, v.content.thumbnailBytes)))
    }

    /* Files a report on the linked item, sealing its key to every operator; anonymous. */
    fun report(item: Opened, category: String, reason: String, email: String?): Boolean {
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val body = Reports.body(api.operators(), item, nodeKey, category, reason, email, JSONObject().put("link", token))
        return api.post("/reports", body).optBoolean("duplicate")
    }
}
