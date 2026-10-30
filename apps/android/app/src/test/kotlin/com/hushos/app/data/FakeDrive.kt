package com.hushos.app.data

import com.hushos.core.Content
import com.hushos.core.IdentityEnvelope
import com.hushos.core.IdentityKeys
import com.hushos.core.LinkContext
import com.hushos.core.MetadataContext
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKeyContext
import com.hushos.core.NodeKind
import com.hushos.core.NodeMetadata
import com.hushos.core.ShareContext
import com.hushos.core.VersionContext
import com.hushos.core.VersionStatement
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.chunkEncrypt
import com.hushos.core.chunkLength
import com.hushos.core.contentSuite
import com.hushos.core.identityCreate
import com.hushos.core.identityOpen
import com.hushos.core.identityUpgrade
import com.hushos.core.linkCreate
import com.hushos.core.linkKdfVersion
import com.hushos.core.linkUrl
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.metadataSign
import com.hushos.core.nodeOpen
import com.hushos.core.nodeWrap
import com.hushos.core.randomBytes
import com.hushos.core.SettingsEnvelope
import com.hushos.core.SettingsKeyEnvelope
import com.hushos.core.settingsKeyCreate
import com.hushos.core.settingsKeyOpen
import com.hushos.core.settingsSeal
import com.hushos.core.shareSeal
import com.hushos.core.versionSeal
import com.hushos.core.versionSign
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.UUID

/*
 * A Drive server on loopback, for driving Vault through its real DriveApi, Auth and PublicApi over HTTP: the routes the
 * re-save paths call (listings, epochs, folders, metadata, copies, uploads and parts, the object store, rotation,
 * shares, links, the identity and the settings), each storing exactly what the client sent. Records are sealed here by
 * the core under keys only this server and the account hold, and `record` opens what the server holds now as a reader
 * on another device would: every key unwrapped from the stored envelopes, from the workspace key down. It checks what
 * a server checks that a re-save could get wrong (the metadata version a write names, the version a replacement
 * expects); it never checks signatures, which the core proves.
 *
 * The account is the web fixture's (its grant is the only way to make one: grants are sealed by the web). Grace is a
 * second account with a drive of her own, who shares a folder with the account or links to one.
 */
class FakeDrive : AutoCloseable {
    private val account = WebFixture.json.getJSONObject("workspace")
    val userId: String = account.getString("userId")
    val accountKey: ByteArray = base64urlDecode(account.getString("accountKey"))
    private val grant: JSONObject = account.getJSONObject("grant")
    val workspace: String = grant.getString("workspaceId")
    val token = "session-" + UUID.randomUUID()

    /* An account whose identity the server serves: its own (opened under the fixture's account key) and Grace's. */
    class Person(val id: String, val envelope: IdentityEnvelope, val keys: IdentityKeys) {
        val served get() = WebFixture.served(envelope)
    }

    private fun person(id: String, root: ByteArray): Person {
        var envelope = identityCreate(id, root, 1uL)
        if (identityOpen(id, root, envelope).identityVersion == 1u) envelope = identityUpgrade(id, root, envelope)
        return Person(id, envelope, identityOpen(id, root, envelope))
    }

    val me = person(userId, accountKey)
    /* Grace's identity as the server serves it now: `startOverGrace` replaces it with no signed chain. */
    var grace = person(UUID.randomUUID().toString(), randomBytes(32u))
        private set

    /* Grace starts her account over (docs/devices-design.md 3): new keys the old ones never signed. */
    fun startOverGrace() = synchronized(lock) { grace = person(grace.id, randomBytes(32u)); owners[graceWorkspace] = grace }

    /* `lookup` answers for Grace's address; `lookups` counts them, `failLookups` makes each one a 500. */
    var lookups = 0
    var failLookups = false
    /* The next settings save lands and its answer is lost (a 500), as a dropped connection would leave it. */
    var loseNextSettingsAnswer = false

    class Version(
        val id: String, val objectId: String, var contentKeyEnvelope: String, val suite: UInt, val chunkCount: Long, val contentNonce: String,
        val signer: String, var signature: String,
    ) {
        fun json(): JSONObject = JSONObject().put("id", id).put("objectId", objectId).put("contentKeyEnvelope", contentKeyEnvelope).put("status", "ready")
            .put("contentSuite", suite.toInt()).put("chunkCount", chunkCount).put("contentNonce", contentNonce).put("plaintextSize", JSONObject.NULL)
            .put("signer", JSONObject().put("id", signer)).put("signature", signature)
    }

    class Node(
        val id: String, val workspaceId: String, val parentId: String?, val kind: String, var keyEpoch: Long, var parentKeyEpoch: Long,
        var keyEnvelope: String, var metadataVersion: Long, var metadataEnvelope: String, var signer: String, var signature: String,
        var version: Version? = null, var changeSeq: Int = 1,
    ) {
        fun json(): JSONObject = JSONObject().put("id", id).put("workspaceId", workspaceId).put("parentId", parentId ?: JSONObject.NULL).put("kind", kind)
            .put("keyEpoch", keyEpoch).put("parentKeyEpoch", parentKeyEpoch).put("keyEnvelope", keyEnvelope)
            .put("metadataVersion", metadataVersion).put("metadataEnvelope", metadataEnvelope).put("currentVersion", version?.json() ?: JSONObject.NULL)
            .put("trashedAt", JSONObject.NULL).put("createdAt", "2026-10-01T00:00:00Z").put("updatedAt", "2026-10-01T00:00:00Z")
            .put("changeSeq", changeSeq).put("envelopeSuite", ENVELOPE_SUITE)
            .put("metadataSigner", JSONObject().put("id", signer)).put("metadataSignature", signature)
    }

    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val origin: String get() = "http://127.0.0.1:${server.address.port}"

    private val lock = Any()
    private val nodes = LinkedHashMap<String, Node>()
    private val objects = HashMap<String, ByteArray>()
    private val workspaceKeys = HashMap<String, ByteArray>()
    private val owners = HashMap<String, Person>()
    private var nextEpoch = 10L
    private var changeSeq = 1
    /* Every request as "METHOD /path", in order. */
    val requests = ArrayList<String>()
    /* Requests no route answered: a test that ends with one here drove a path the fake does not know. */
    val unknown = ArrayList<String>()

    val root: String
    val graceWorkspace = UUID.randomUUID().toString()
    val graceRoot: String

    init {
        workspaceKeys[workspace] = base64urlDecode(account.getString("workspaceKey"))
        owners[workspace] = me
        root = seedNode(workspace, null, "folder", NodeMetadata(ROOT_NAME, null, null, null, emptyMap()), parentEpoch = grant.getLong("workspaceKeyVersion"))
        workspaceKeys[graceWorkspace] = randomBytes(32u)
        owners[graceWorkspace] = grace
        graceRoot = seedNode(graceWorkspace, null, "folder", NodeMetadata(ROOT_NAME, null, null, null, emptyMap()), parentEpoch = 1L)
        server.createContext("/") { exchange -> synchronized(lock) { answer(exchange) } }
        server.start()
    }

    override fun close() = server.stop(0)

    // Seeding: records another client wrote, signed by the workspace's owner.

    fun folder(parentId: String, name: String, attributes: Map<String, String> = emptyMap()): String = synchronized(lock) {
        seedNode(node(parentId).workspaceId, parentId, "folder", NodeMetadata(name, null, null, null, attributes))
    }

    fun file(parentId: String, name: String, bytes: ByteArray, attributes: Map<String, String> = emptyMap()): String = synchronized(lock) {
        val ws = node(parentId).workspaceId
        val id = seedNode(ws, parentId, "file", NodeMetadata(name, "text/plain", bytes.size.toULong(), "2026-09-30T12:00:00Z", attributes))
        val node = node(id)
        val versionId = UUID.randomUUID().toString()
        val objectId = UUID.randomUUID().toString()
        val contentKey = randomBytes(32u)
        val nonce = randomBytes(16u)
        val suite = contentSuite()
        val sealed = versionSeal(VersionContext(ws, id, versionId, objectId), keyOf(id), contentKey, bytes.size.toULong(), 0u)
        val content = Content(ws, objectId, suite, contentKey, nonce, bytes.size.toULong(), 0u)
        val out = ByteArrayOutputStream()
        for (index in 0uL until sealed.layout.chunkCount) {
            val start = (index * sealed.layout.chunkBytes).toInt()
            out.write(chunkEncrypt(content, index, bytes.copyOfRange(start, start + chunkLength(bytes.size.toULong(), index).toInt())))
        }
        objects[objectId] = out.toByteArray()
        val signature = versionSign(owners.getValue(ws).keys.signingSeed, VersionStatement(ws, id, versionId, objectId, suite), sealed.envelope)
        node.version = Version(versionId, objectId, base64urlEncode(sealed.envelope), suite, sealed.layout.chunkCount.toLong(), base64urlEncode(nonce),
            owners.getValue(ws).id, base64urlEncode(signature))
        id
    }

    private fun seedNode(ws: String, parentId: String?, kind: String, metadata: NodeMetadata, parentEpoch: Long? = null): String {
        val id = UUID.randomUUID().toString()
        val key = randomBytes(32u)
        val epoch = nextEpoch++
        val parentKeyEpoch = parentEpoch ?: node(parentId!!).keyEpoch
        val parentKey = parentId?.let { keyOf(it) } ?: workspaceKeys.getValue(ws)
        val wrapped = nodeWrap(NodeKeyContext(ws, id, parentId ?: ws, parentKeyEpoch.toULong(), epoch.toULong()), parentKey, key)
        val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, metadata)
        val signature = metadataSign(owners.getValue(ws).keys.signingSeed, MetadataStatement(ws, id, if (kind == "folder") NodeKind.FOLDER else NodeKind.FILE, 1uL), sealed)
        nodes[id] = Node(id, ws, parentId, kind, epoch, parentKeyEpoch, base64urlEncode(wrapped), 1L, base64urlEncode(sealed), owners.getValue(ws).id,
            base64urlEncode(signature), changeSeq = changeSeq++)
        return id
    }

    // Reading what the server holds, as another device would.

    fun node(id: String): Node = synchronized(lock) { nodes[id] ?: throw AssertionError("The server holds no node $id") }

    fun children(parentId: String): List<Node> = synchronized(lock) { nodes.values.filter { it.parentId == parentId } }

    /* Gone from the server's listings, as a trash or a purge on another device leaves it (the children route omits trashed rows). */
    fun drop(id: String) = synchronized(lock) { nodes.remove(id); bump(nodes.values.first()) }

    fun child(parentId: String, name: String): Node = children(parentId).singleOrNull { record(it.id).name == name }
        ?: throw AssertionError("No single “$name” in $parentId: ${children(parentId).map { record(it.id).name }}")

    /* A node's key, unwrapped from the envelopes the server holds, from its workspace key down. */
    fun keyOf(id: String): ByteArray = synchronized(lock) {
        val node = node(id)
        val parentKey = node.parentId?.let { keyOf(it) } ?: workspaceKeys.getValue(node.workspaceId)
        nodeOpen(NodeKeyContext(node.workspaceId, id, node.parentId ?: node.workspaceId, node.parentKeyEpoch.toULong(), node.keyEpoch.toULong()), parentKey,
            base64urlDecode(node.keyEnvelope))
    }

    /* The record the server holds for `id`, opened under that key at the version it is stored at. */
    fun record(id: String): NodeMetadata = synchronized(lock) {
        val node = node(id)
        metadataOpen(MetadataContext(node.workspaceId, id, node.metadataVersion.toULong()), keyOf(id), base64urlDecode(node.metadataEnvelope))
    }

    // Shares, links and settings.

    private data class Share(val id: String, val node: String, val envelope: String, val keyEpoch: Long, val granter: Person? = null)
    private val shares = ArrayList<Share>()
    /* Grace shares `nodeId` (in her drive) with the account, sealed to its identity in suite 4. */
    fun shareWithMe(nodeId: String, servedAs: Person? = null) = synchronized(lock) {
        val node = node(nodeId)
        val kem = base64urlDecode(me.keys.kemPublicKey!!)
        val envelope = shareSeal(ShareContext(node.workspaceId, nodeId, node.keyEpoch.toULong(), userId, grace.id), keyOf(nodeId), grace.keys,
            base64urlDecode(me.keys.encryptionPublicKey), kem)
        // `servedAs`: the granter's identity this one row is listed with (a server serving other keys mid-list).
        shares.add(Share(UUID.randomUUID().toString(), nodeId, base64urlEncode(envelope), node.keyEpoch, servedAs))
    }

    /* Another account the server can name: an identity of its own under Grace's id, as a server swapping her keys would serve. */
    fun impostorOfGrace(): Person = person(grace.id, randomBytes(32u))

    /*
     * The settings as another device (or a server replaying a copy) leaves them: opened, changed by `change`, and sealed one
     * version up under the account's settings key, as any save is.
     */
    fun editSettings(change: (Settings) -> Unit) = synchronized(lock) {
        val key = settingsKey?.let { settingsKeyOpen(userId, accountKey, SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext"))) }
            ?: settingsKeyCreate(userId, accountKey).also { settingsKey = JSONObject().put("nonce", it.envelope.nonce).put("ciphertext", it.envelope.ciphertext) }.key
        val current = settingsDocument?.let {
            openSettingsText(userId, key, SettingsEnvelope(it.getInt("version").toUInt(), it.getLong("settingsVersion").toULong(), it.getString("nonce"), it.getString("ciphertext")))
        } ?: Settings.empty(settingsVersion.toULong())
        change(current)
        val sealed = settingsSeal(userId, key, (settingsVersion + 1).toULong(), current.text())
        settingsDocument = JSONObject().put("version", sealed.version.toInt()).put("settingsVersion", sealed.settingsVersion.toLong())
            .put("nonce", sealed.nonce).put("ciphertext", sealed.ciphertext)
        settingsVersion = sealed.settingsVersion.toLong()
    }

    /* The settings as the server holds them now, opened as another device would. */
    fun settings(): Settings = synchronized(lock) {
        val key = settingsKeyOpen(userId, accountKey, SettingsKeyEnvelope(settingsKey!!.getString("nonce"), settingsKey!!.getString("ciphertext")))
        val doc = settingsDocument!!
        openSettingsText(userId, key, SettingsEnvelope(doc.getInt("version").toUInt(), doc.getLong("settingsVersion").toULong(), doc.getString("nonce"), doc.getString("ciphertext")))
    }

    /* The settings document and its key, as the server keeps them: the key stored once, the document compare-and-set. */
    private var settingsKey: JSONObject? = null
    private var settingsDocument: JSONObject? = null
    private var settingsVersion = 0L

    private fun settingsJson() = JSONObject().put("settings", settingsDocument ?: JSONObject.NULL).put("settingsKey", settingsKey ?: JSONObject.NULL)
        .put("settingsVersion", settingsVersion)

    /*
     * The account has compared words with Grace: her version 3 pin in its settings, sealed one version up under the
     * settings key the server holds (the one a device stored, opened under the account key), or a first one stored here.
     */
    fun pinGrace() = synchronized(lock) {
        val pin = ContactPin.ofServed(grace.id, "grace@example.org", "Grace", grace.served, "2026-10-01T00:00:00Z")!!
        val key = settingsKey?.let { settingsKeyOpen(userId, accountKey, SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext"))) }
            ?: settingsKeyCreate(userId, accountKey).also { settingsKey = JSONObject().put("nonce", it.envelope.nonce).put("ciphertext", it.envelope.ciphertext) }.key
        val current = settingsDocument?.let {
            openSettingsText(userId, key, SettingsEnvelope(it.getInt("version").toUInt(), it.getLong("settingsVersion").toULong(), it.getString("nonce"), it.getString("ciphertext")))
        } ?: Settings.empty(settingsVersion.toULong())
        current.pin(pin)
        val sealed = settingsSeal(userId, key, (settingsVersion + 1).toULong(), current.text())
        settingsDocument = JSONObject().put("version", sealed.version.toInt()).put("settingsVersion", sealed.settingsVersion.toLong())
            .put("nonce", sealed.nonce).put("ciphertext", sealed.ciphertext)
        settingsVersion = sealed.settingsVersion.toLong()
    }

    private data class Link(val id: String, val node: String, val token: String, val created: com.hushos.core.CreatedLink, val keyEpoch: Long)
    private val links = ArrayList<Link>()

    /* A link to `nodeId` without a password; the URL a visitor opens. */
    fun link(nodeId: String): String = synchronized(lock) {
        val node = node(nodeId)
        val id = UUID.randomUUID().toString()
        val created = linkCreate(LinkContext(node.workspaceId, nodeId, node.keyEpoch.toULong(), id), keyOf(nodeId), null)
        links.add(Link(id, nodeId, created.token, created, node.keyEpoch))
        linkUrl(origin, created.token, created.secret)
    }

    // The routes.

    private class Upload(val ws: String, val body: JSONObject, val parts: HashMap<Int, ByteArray> = HashMap())
    private val uploads = HashMap<String, Upload>()
    private class Rotation(val ws: String, val target: Long, val applied: HashSet<String> = HashSet())
    private val rotations = HashMap<String, Rotation>()

    private fun answer(exchange: HttpExchange) {
        val method = exchange.requestMethod
        val path = exchange.requestURI.rawPath
        val query = (exchange.requestURI.rawQuery ?: "").split("&").filter { it.contains("=") }
            .associate { it.substringBefore("=") to URLDecoder.decode(it.substringAfter("="), "UTF-8") }
        val raw = exchange.requestBody.readBytes()
        requests.add("$method $path")
        try {
            if (path.startsWith("/store/")) return store(exchange, method, path, raw)
            val body = if (raw.isEmpty()) JSONObject() else runCatching { JSONObject(String(raw)) }.getOrDefault(JSONObject())
            val public = path.startsWith("/api/drive/links/")
            if (!public && exchange.requestHeaders.getFirst("Cookie") != "hushos-session=$token") return send(exchange, 401, JSONObject().put("message", "Sign in"))
            val reply = route(method, path.removePrefix("/api"), query, body, exchange.requestHeaders.getFirst(LINK_TOKEN_HEADER))
            if (reply == null) {
                unknown.add("$method $path")
                send(exchange, 404, JSONObject().put("message", "No such route here: $method $path"))
            } else send(exchange, reply.first, reply.second)
        } catch (error: Throwable) {
            unknown.add("$method $path threw $error")
            send(exchange, 500, JSONObject().put("message", error.toString()))
        }
    }

    private fun send(exchange: HttpExchange, status: Int, body: JSONObject, headers: Map<String, String> = emptyMap()) {
        val bytes = body.toString().toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        for ((k, v) in headers) exchange.responseHeaders.add(k, v)
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun store(exchange: HttpExchange, method: String, path: String, raw: ByteArray) {
        val parts = path.removePrefix("/store/").split("/")
        when {
            method == "PUT" && parts[0] == "parts" -> {
                uploads.getValue(parts[1]).parts[parts[2].toInt()] = raw
                exchange.responseHeaders.add("ETag", "\"part-${parts[2]}\"")
                exchange.sendResponseHeaders(200, -1)
                exchange.close()
            }
            method == "GET" && parts[0] == "objects" -> {
                val bytes = objects.getValue(parts[1])
                val (start, end) = exchange.requestHeaders.getFirst("Range")!!.removePrefix("bytes=").split("-").map { it.toInt() }
                val slice = bytes.copyOfRange(start, minOf(end + 1, bytes.size))
                exchange.sendResponseHeaders(206, slice.size.toLong())
                exchange.responseBody.use { it.write(slice) }
            }
            else -> { unknown.add("$method $path"); exchange.sendResponseHeaders(404, -1); exchange.close() }
        }
    }

    private fun ok(json: JSONObject) = 200 to json
    private fun conflict(message: String) = 409 to JSONObject().put("message", message).put("code", "conflict")
    private fun listing(folder: Node) = JSONObject().put("folder", folder.json()).put("ancestors", JSONArray())
        .put("children", JSONArray(children(folder.id).map { it.json() })).put("nextCursor", JSONObject.NULL)
    private fun objectUrl(objectId: String) = "$origin/store/objects/$objectId"
    private fun versionById(id: String): Pair<Node, Version>? = nodes.values.firstNotNullOfOrNull { n -> n.version?.takeIf { it.id == id }?.let { n to it } }
    private fun bump(node: Node) { node.changeSeq = changeSeq++ }

    private fun route(method: String, path: String, query: Map<String, String>, body: JSONObject, linkToken: String?): Pair<Int, JSONObject>? {
        val segments = path.trim('/').split("/")
        fun at(vararg pattern: String) = segments.size == pattern.size && pattern.indices.all { pattern[it] == "*" || pattern[it] == segments[it] }
        val get = method == "GET"
        val post = method == "POST"
        return when {
            // The account's own routes (Auth.call).
            get && at("auth", "identity") -> ok(JSONObject().put("identity", Auth.json(me.envelope)))
            get && at("auth", "identity", "history") -> ok(JSONObject().put("identities", JSONArray()))
            get && at("auth", "settings") -> ok(settingsJson())
            method == "PUT" && at("auth", "settings-key") -> {
                if (settingsKey != null) return conflict("A settings key is already stored")
                settingsKey = JSONObject().put("nonce", body.getString("nonce")).put("ciphertext", body.getString("ciphertext"))
                ok(JSONObject())
            }
            method == "PUT" && at("auth", "settings") -> {
                if (body.getLong("expectedVersion") != settingsVersion) return conflict("Settings changed since you read them")
                settingsVersion++
                settingsDocument = JSONObject().put("version", body.getInt("version")).put("settingsVersion", settingsVersion)
                    .put("nonce", body.getString("nonce")).put("ciphertext", body.getString("ciphertext"))
                if (loseNextSettingsAnswer) { loseNextSettingsAnswer = false; return 500 to JSONObject().put("message", "The answer was lost") }
                ok(JSONObject().put("settingsVersion", settingsVersion))
            }
            post && at("auth", "contacts", "lookup") -> {
                lookups++
                if (failLookups) return 500 to JSONObject().put("message", "Lookups are down")
                if (!body.getString("email").equals("grace@example.org", ignoreCase = true)) return 404 to JSONObject().put("message", "No HushOS account uses that email.")
                ok(JSONObject().put("contact", grace.served.toJson().put("userId", grace.id).put("name", "Grace Hopper").put("email", "grace@example.org")))
            }
            get && at("auth", "contacts", "*", "succession") -> ok(JSONObject().put("links", JSONArray()))

            get && at("drive", "workspace") -> ok(JSONObject().put("workspaceId", workspace).put("changeSeq", changeSeq).put("grant", grant).put("root", node(root).json()))
            get && at("drive", "nodes", "*", "children") -> {
                val folder = nodes[segments[2]]?.takeIf { it.workspaceId == query["workspaceId"] } ?: return 404 to JSONObject().put("message", "Not found")
                ok(listing(folder))
            }
            get && at("drive", "versions", "*", "url") -> versionById(segments[2])?.let { ok(JSONObject().put("url", objectUrl(it.second.objectId))) }
            get && at("drive", "thumbnails") -> ok(JSONObject().put("urls", JSONArray()))
            post && at("drive", "workspaces", "*", "epochs") -> ok(JSONObject().put("from", nextEpoch++))
            post && at("drive", "folders") -> {
                val made = (0 until body.getJSONArray("folders").length()).map { i ->
                    val f = body.getJSONArray("folders").getJSONObject(i)
                    Node(f.getString("id"), body.getString("workspaceId"), f.getString("parentId"), "folder", f.getLong("keyEpoch"), f.getLong("parentKeyEpoch"),
                        f.getString("keyEnvelope"), 1L, f.getString("metadataEnvelope"), userId, f.getString("metadataSignature"), changeSeq = changeSeq++)
                        .also { nodes[it.id] = it }
                }
                ok(JSONObject().put("nodes", JSONArray(made.map { it.json() })))
            }
            post && at("drive", "nodes", "*", "metadata") -> {
                val node = node(segments[2])
                if (body.getLong("metadataVersion") != node.metadataVersion) return conflict("Changed since you read it")
                if (body.getLong("keyEpoch") != node.keyEpoch) return conflict("Wrong key epoch")
                node.metadataEnvelope = body.getString("metadataEnvelope")
                node.signature = body.getString("metadataSignature")
                node.signer = userId
                node.metadataVersion++
                bump(node)
                ok(JSONObject().put("node", node.json()))
            }
            post && at("drive", "nodes", "*", "copy") -> {
                val source = node(segments[2])
                val from = source.version!!.takeIf { it.id == body.getString("sourceVersionId") } ?: return conflict("Not the current version")
                val n = body.getJSONObject("node")
                val copy = Node(n.getString("id"), body.getString("workspaceId"), n.getString("parentId"), "file", n.getLong("keyEpoch"), n.getLong("parentKeyEpoch"),
                    n.getString("keyEnvelope"), 1L, n.getString("metadataEnvelope"), userId, n.getString("metadataSignature"), changeSeq = changeSeq++)
                copy.version = Version(body.getString("versionId"), from.objectId, body.getString("contentKeyEnvelope"), from.suite, from.chunkCount, from.contentNonce,
                    userId, body.getString("versionSignature"))
                nodes[copy.id] = copy
                ok(JSONObject().put("node", copy.json()))
            }
            post && at("drive", "uploads") -> {
                val id = UUID.randomUUID().toString()
                uploads[id] = Upload(body.getString("workspaceId"), body)
                val count = minOf(body.getLong("chunkCount"), 64L).toInt()
                ok(JSONObject().put("upload", JSONObject().put("id", id))
                    .put("parts", JSONArray((1..count).map { JSONObject().put("partNumber", it).put("url", "$origin/store/parts/$id/$it") })))
            }
            get && at("drive", "uploads", "*", "parts") -> {
                val from = query.getValue("from").toInt()
                val last = minOf(uploads.getValue(segments[2]).body.getLong("chunkCount").toInt(), from + 63)
                ok(JSONObject().put("parts", JSONArray((from..last).map { JSONObject().put("partNumber", it).put("url", "$origin/store/parts/${segments[2]}/$it") })))
            }
            post && at("drive", "uploads", "*", "abort") -> { uploads.remove(segments[2]); ok(JSONObject()) }
            post && at("drive", "uploads", "*", "complete") -> {
                val upload = uploads.remove(segments[2]) ?: return 404 to JSONObject().put("message", "No upload")
                val b = upload.body
                val n = b.getJSONObject("node")
                val listed = body.getJSONArray("parts")
                val bytes = ByteArrayOutputStream()
                for (i in 0 until listed.length()) bytes.write(upload.parts.getValue(listed.getJSONObject(i).getInt("partNumber")))
                val objectId = b.getString("objectId")
                objects[objectId] = bytes.toByteArray()
                val version = Version(b.getString("versionId"), objectId, b.getString("contentKeyEnvelope"), b.getInt("contentSuite").toUInt(), b.getLong("chunkCount"),
                    b.getString("contentNonce"), userId, b.getString("versionSignature"))
                val node = if (n.getBoolean("existing")) {
                    val existing = node(n.getString("id"))
                    val expected = if (n.isNull("expectedVersionId")) null else n.getString("expectedVersionId")
                    if (existing.version?.id != expected) return conflict("A newer version is there")
                    existing.also { bump(it) }
                } else Node(n.getString("id"), upload.ws, n.getString("parentId"), "file", n.getLong("keyEpoch"), n.getLong("parentKeyEpoch"),
                    n.getString("keyEnvelope"), 1L, n.getString("metadataEnvelope"), userId, n.getString("metadataSignature"), changeSeq = changeSeq++)
                node.version = version
                nodes[node.id] = node
                ok(JSONObject().put("node", node.json()))
            }
            post && at("drive", "nodes", "*", "rotation") -> {
                val rotation = Rotation(body.getString("workspaceId"), nextEpoch++)
                rotations[segments[2]] = rotation
                ok(JSONObject().put("rotation", JSONObject().put("targetEpoch", rotation.target)))
            }
            get && at("drive", "nodes", "*", "rotation", "work") -> {
                val rotation = rotations.getValue(segments[2])
                // Parents first: the subtree breadth first, less what was applied.
                val order = ArrayList<Node>()
                val queue = ArrayDeque(listOf(node(segments[2])))
                while (queue.isNotEmpty()) queue.removeFirst().also { order.add(it); queue.addAll(children(it.id)) }
                val todo = order.filter { it.id !in rotation.applied }
                val work = todo.map { node ->
                    node.json().put("versions", JSONArray(listOfNotNull(node.version).map { v ->
                        JSONObject().put("id", v.id).put("objectId", v.objectId).put("contentSuite", v.suite.toInt()).put("contentKeyEnvelope", v.contentKeyEnvelope)
                            .put("plaintextSize", JSONObject.NULL).put("signer", JSONObject().put("id", v.signer)).put("signature", v.signature)
                    })).put("shares", JSONArray()).put("links", JSONArray())
                }
                ok(JSONObject().put("rotation", JSONObject().put("targetEpoch", rotation.target)).put("nodes", JSONArray(work))
                    .put("nextCursor", JSONObject.NULL).put("done", todo.isEmpty()))
            }
            post && at("drive", "nodes", "*", "rotation", "nodes") -> {
                val rotation = rotations.getValue(segments[2])
                val wires = body.getJSONArray("nodes")
                val results = JSONArray()
                for (i in 0 until wires.length()) {
                    val wire = wires.getJSONObject(i)
                    val node = node(wire.getString("id"))
                    node.parentKeyEpoch = wire.getLong("parentKeyEpoch")
                    node.keyEnvelope = wire.getString("keyEnvelope")
                    wire.optJSONObject("rotated")?.let { rotated ->
                        node.keyEpoch = rotation.target
                        node.metadataEnvelope = rotated.getString("metadataEnvelope")
                        node.signature = rotated.getString("metadataSignature")
                        node.signer = userId
                        val versions = rotated.getJSONArray("versions")
                        for (j in 0 until versions.length()) {
                            val v = versions.getJSONObject(j)
                            node.version?.takeIf { it.id == v.getString("id") }?.let { it.contentKeyEnvelope = v.getString("contentKeyEnvelope"); it.signature = v.getString("signature") }
                        }
                    }
                    bump(node)
                    rotation.applied.add(node.id)
                    results.put(JSONObject().put("id", node.id).put("status", "ok"))
                }
                ok(JSONObject().put("results", results))
            }
            get && at("drive", "shares") -> ok(JSONObject().put("shares", JSONArray(shares.map { share ->
                JSONObject().put("id", share.id).put("workspaceId", node(share.node).workspaceId).put("role", "editor").put("createdAt", "2026-10-01T00:00:00Z")
                    .put("keyEpoch", share.keyEpoch).put("shareEnvelope", share.envelope)
                    .put("granter", (share.granter ?: grace).served.toJson().put("id", grace.id).put("name", "Grace").put("email", "grace@example.org"))
                    .put("node", node(share.node).json())
            })))

            // A visitor's link routes (PublicApi): no session, the token in its header.
            get && at("drive", "links", "open") -> {
                val link = links.firstOrNull { it.token == linkToken } ?: return 404 to JSONObject().put("message", "No link")
                ok(JSONObject().put("link", JSONObject().put("id", link.id).put("workspaceId", node(link.node).workspaceId).put("keyEpoch", link.keyEpoch)
                    .put("hasPassword", false).put("linkSalt", link.created.linkSalt).put("linkEnvelope", link.created.linkEnvelope)
                    .put("expiresAt", JSONObject.NULL).put("kdfVersion", linkKdfVersion().toInt())).put("node", node(link.node).json()))
            }
            get && at("drive", "links", "nodes", "*", "children") -> {
                if (links.none { it.token == linkToken }) return 404 to JSONObject().put("message", "No link")
                ok(listing(node(segments[3])))
            }
            get && at("drive", "links", "versions", "*", "url") -> versionById(segments[3])?.let { ok(JSONObject().put("url", objectUrl(it.second.objectId))) }
            get && at("drive", "links", "thumbnails") -> ok(JSONObject().put("urls", JSONArray()))
            else -> null
        }
    }
}
