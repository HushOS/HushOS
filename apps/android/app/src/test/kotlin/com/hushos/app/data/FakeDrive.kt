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
    /* Runs as each settings save lands (another process acting meanwhile, say). */
    var onSettingsPut: (() -> Unit)? = null
    /* Shares the account made (createShare), and the shares a rotation's work lists per node. */
    val sharesMade = ArrayList<JSONObject>()
    val rotationShares = HashMap<String, MutableList<JSONObject>>()
    /* Settings reads fail (a 500) once a rotation's work has been listed: a check mid-batch that can't run. */
    var failSettingsOnceWorkListed = false
    /* Each request with the `HushOS-Client` it named, in order. */
    val clients = java.util.Collections.synchronizedList(ArrayList<Pair<String, String?>>())
    /* Every settings read fails with a 503 while set (the server or the connection down for that route). */
    @Volatile var failSettingsReads = false
    /* Every settings read answered with this while set (a refusal, not a server down). */
    @Volatile var settingsReadAnswer: Pair<Int, JSONObject>? = null
    /* People besides Grace that `lookup` answers for, by address (lowercase): their keys and name. */
    val others = java.util.concurrent.ConcurrentHashMap<String, Pair<Person, String>>()
    fun another(email: String, name: String): Person = person(UUID.randomUUID().toString(), randomBytes(32u)).also { others[email.lowercase()] = it to name }
    /* Runs once, as the next settings read is answered (another process acting right after it). */
    var onNextSettingsGet: (() -> Unit)? = null
    /* Rotation batches are refused with a 500, as a dropped send would leave them (nothing applied). */
    var failRotationSend = false
    /* At most this many nodes per batch of rotation work (null: all at once), as the server sizes them. */
    var rotationBatch: Int? = null
    /* The rotation sends (counted from 1) refused with a 500, as a dropped connection leaves them. */
    var failRotationSends: Set<Int> = emptySet()
    /* The rotation sends (counted from 1) applied whose answer is lost (a 500), as a process killed mid-send leaves them. */
    var loseRotationAnswers: Set<Int> = emptySet()
    /* The ids each rotation send carried, in order. */
    val rotationBatches = ArrayList<List<String>>()
    private var rotationSends = 0
    /* The feed as the server pages it: at most this many changes a page (null: all at once). */
    var changesPage: Int? = null
    /* Cursors from 1 below this predate a dropped tombstone: the feed answers `resync`, as the server does. */
    var tombstonesDroppedThrough = 0
    /* Feed pages still answered before each one fails with a 500 (null: all are answered). */
    var changePagesLeft: Int? = null
    private var changesServed = 0
    /* Nodes the feed leaves out, as a page this device missed would: a sync then holds rows under a folder it never saw. */
    val missedByFeed = HashSet<String>()
    /* The node changes again (a write elsewhere): the feed has it after any cursor up to now. */
    fun touch(id: String) = synchronized(lock) { bump(node(id)) }

    /* `id` goes to the Trash, as the server keeps it: its parent's listing leaves it out, the trash listing has it. */
    fun trash(id: String) = synchronized(lock) { node(id).trashedAt = "2026-10-30T00:00:00Z"; bump(node(id)) }
    private var workListed = false

    class Version(
        val id: String, val objectId: String, var contentKeyEnvelope: String, val suite: UInt, val chunkCount: Long, val contentNonce: String,
        var signer: String, var signature: String,
        /* What a family folder's walk kept of the version's writer (RekeyView): served as `rekey`, the signature then none. */
        var rekey: JSONObject? = null,
    ) {
        fun json(): JSONObject = JSONObject().put("id", id).put("objectId", objectId).put("contentKeyEnvelope", contentKeyEnvelope).put("status", "ready")
            .put("contentSuite", suite.toInt()).put("chunkCount", chunkCount).put("contentNonce", contentNonce).put("plaintextSize", JSONObject.NULL)
            .put("signer", JSONObject().put("id", signer)).put("signature", signature.ifEmpty { null } ?: JSONObject.NULL).put("rekey", rekey ?: JSONObject.NULL)
    }

    class Node(
        val id: String, val workspaceId: String, var parentId: String?, val kind: String, var keyEpoch: Long, var parentKeyEpoch: Long,
        var keyEnvelope: String, var metadataVersion: Long, var metadataEnvelope: String, var signer: String, var signature: String,
        var version: Version? = null, var changeSeq: Int = 1, var trashedAt: String? = null,
    ) {
        /* The envelope, key epoch and parent epoch before the node's first re-key in a run (the server's prevKeyEnvelope). */
        var previous: Triple<String, Long, Long>? = null
        /* What a family folder's walk kept of the metadata's writer, served as `metadataRekey`. */
        var metadataRekey: JSONObject? = null

        fun json(): JSONObject = JSONObject().put("id", id).put("workspaceId", workspaceId).put("parentId", parentId ?: JSONObject.NULL).put("kind", kind)
            .put("keyEpoch", keyEpoch).put("parentKeyEpoch", parentKeyEpoch).put("keyEnvelope", keyEnvelope)
            .put("metadataVersion", metadataVersion).put("metadataEnvelope", metadataEnvelope).put("currentVersion", version?.json() ?: JSONObject.NULL)
            .put("trashedAt", trashedAt ?: JSONObject.NULL).put("createdAt", "2026-10-01T00:00:00Z").put("updatedAt", "2026-10-01T00:00:00Z")
            .put("changeSeq", changeSeq).put("envelopeSuite", ENVELOPE_SUITE)
            .put("metadataSigner", JSONObject().put("id", signer)).put("metadataSignature", signature.ifEmpty { null } ?: JSONObject.NULL)
            .put("metadataRekey", metadataRekey ?: JSONObject.NULL)
            .apply {
                previous?.let { (envelope, epoch, parentEpoch) -> put("prevKeyEnvelope", envelope).put("prevKeyEpoch", epoch).put("prevParentKeyEpoch", parentEpoch) }
            }
    }

    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    /* Runs before a request is answered, outside the server's lock: a test holds one request there while others go on. */
    @Volatile var beforeAnswer: ((method: String, path: String) -> Unit)? = null
    private val workers = java.util.concurrent.Executors.newCachedThreadPool()

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
        // A request may be held before it is answered (`beforeAnswer`) while others are answered meanwhile, one at a time.
        server.executor = workers
        server.createContext("/") { exchange ->
            beforeAnswer?.invoke(exchange.requestMethod, exchange.requestURI.path.removePrefix("/api/"))
            synchronized(lock) { answer(exchange) }
        }
        server.start()
    }

    override fun close() {
        server.stop(0)
        workers.shutdownNow()
    }

    // Seeding: records another client wrote, signed by the workspace's owner.

    fun folder(parentId: String, name: String, attributes: Map<String, String> = emptyMap()): String = synchronized(lock) {
        seedNode(node(parentId).workspaceId, parentId, "folder", NodeMetadata(name, null, null, null, attributes))
    }

    fun file(parentId: String, name: String, bytes: ByteArray, attributes: Map<String, String> = emptyMap()): String = synchronized(lock) {
        val ws = node(parentId).workspaceId
        val id = seedNode(ws, parentId, "file", NodeMetadata(name, "text/plain", bytes.size.toULong(), "2026-09-30T12:00:00Z", attributes))
        newVersion(id, bytes)
        id
    }

    /* Its workspace's owner renames `id`, as another member's device would: the name sealed one metadata version up and signed. */
    fun renameAs(id: String, name: String) = synchronized(lock) {
        val node = node(id)
        val ws = node.workspaceId
        val version = node.metadataVersion + 1
        val sealed = metadataSeal(MetadataContext(ws, id, version.toULong()), keyOf(id), NodeMetadata(name, "text/plain", null, "2026-10-31T12:00:00Z", emptyMap()))
        node.metadataEnvelope = base64urlEncode(sealed)
        node.signature = base64urlEncode(metadataSign(owners.getValue(ws).keys.signingSeed, MetadataStatement(ws, id, NodeKind.FILE, version.toULong()), sealed))
        node.signer = owners.getValue(ws).id
        node.metadataVersion = version
        bump(node)
    }

    /*
     * The owner re-keys folder `id` (a revoke-and-rotate): a new key and key epoch, its name sealed and signed again under
     * it, and each child's key wrapped again under the new key. The children's own keys are unchanged.
     */
    fun rekeyFolderAs(id: String) = synchronized(lock) {
        val node = node(id)
        val ws = node.workspaceId
        val oldKey = keyOf(id)
        val childKeys = children(id).associate { it.id to keyOf(it.id) }
        val metadata = metadataOpen(MetadataContext(ws, id, node.metadataVersion.toULong()), oldKey, base64urlDecode(node.metadataEnvelope))
        val newKey = randomBytes(32u)
        val epoch = nextEpoch++
        val parentKey = node.parentId?.let { keyOf(it) } ?: workspaceKeys.getValue(ws)
        node.keyEnvelope = base64urlEncode(nodeWrap(NodeKeyContext(ws, id, node.parentId ?: ws, node.parentKeyEpoch.toULong(), epoch.toULong()), parentKey, newKey))
        node.keyEpoch = epoch
        val sealed = metadataSeal(MetadataContext(ws, id, node.metadataVersion.toULong()), newKey, metadata)
        node.metadataEnvelope = base64urlEncode(sealed)
        node.signature = base64urlEncode(metadataSign(owners.getValue(ws).keys.signingSeed, MetadataStatement(ws, id, NodeKind.FOLDER, node.metadataVersion.toULong()), sealed))
        node.signer = owners.getValue(ws).id
        bump(node)
        for (child in children(id)) {
            child.parentKeyEpoch = epoch
            child.keyEnvelope = base64urlEncode(nodeWrap(NodeKeyContext(ws, child.id, id, epoch.toULong(), child.keyEpoch.toULong()), newKey, childKeys.getValue(child.id)))
            bump(child)
        }
    }

    /* `id` moved under `parentId` by another device: its key wrapped again under the new parent's, as a move is. */
    fun moveAs(id: String, parentId: String) = synchronized(lock) {
        val node = node(id)
        val parent = node(parentId)
        val wrapped = nodeWrap(NodeKeyContext(node.workspaceId, id, parentId, parent.keyEpoch.toULong(), node.keyEpoch.toULong()), keyOf(parentId), keyOf(id))
        val moved = Node(id, node.workspaceId, parentId, node.kind, node.keyEpoch, parent.keyEpoch, base64urlEncode(wrapped), node.metadataVersion,
            node.metadataEnvelope, node.signer, node.signature, node.version, node.changeSeq, node.trashedAt)
        nodes[id] = moved
        bump(moved)
    }

    /* A file in `parentId` signed by `signer` instead of its workspace's owner: someone outside the family wrote it. */
    fun fileAs(signer: Person, parentId: String, name: String, bytes: ByteArray): String = synchronized(lock) {
        val ws = node(parentId).workspaceId
        val owner = owners.getValue(ws)
        owners[ws] = signer
        try { file(parentId, name, bytes) } finally { owners[ws] = owner }
    }

    /* Its workspace's owner uploads new content for `id`: a new current version, sealed and signed as an upload is. */
    fun newVersion(id: String, bytes: ByteArray, bumped: Boolean = true) = synchronized(lock) {
        val ws = node(id).workspaceId
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
        if (bumped) bump(node)
    }

    /* Another workspace this server holds (a family folder): its key and whose records it holds. */
    fun seedWorkspace(ws: String, key: ByteArray, owner: Person) = synchronized(lock) { workspaceKeys[ws] = key; owners[ws] = owner }

    /* A node with an id and key the caller chose (a family folder's top folder, whose key the member list commits to). */
    fun seedNodeWith(ws: String, parentId: String?, kind: String, metadata: NodeMetadata, id: String, key: ByteArray, parentEpoch: Long, epoch: Long): String =
        synchronized(lock) { seedNode(ws, parentId, kind, metadata, parentEpoch, id, key, epoch) }

    /* Routes another fake answers first (the group routes, FamilyServer): null lets these answer. */
    var extraRoutes: ((method: String, segments: List<String>, query: Map<String, String>, body: JSONObject) -> Pair<Int, JSONObject>?)? = null

    private fun seedNode(ws: String, parentId: String?, kind: String, metadata: NodeMetadata, parentEpoch: Long? = null, chosenId: String? = null,
                         chosenKey: ByteArray? = null, chosenEpoch: Long? = null): String {
        val id = chosenId ?: UUID.randomUUID().toString()
        val key = chosenKey ?: randomBytes(32u)
        val epoch = chosenEpoch ?: nextEpoch++
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

    /* Keys a node had before a re-key in a run, by node and key epoch: what its children not reached yet are wrapped under. */
    private val previousKeys = HashMap<Pair<String, Long>, ByteArray>()

    /* `id`'s key as it is now, kept as its previous one before something re-keys it (a manager's roster rotation of a top folder). */
    fun keepPreviousKey(id: String) = synchronized(lock) { previousKeys[id to node(id).keyEpoch] = keyOf(id) }

    /* A node's key at `epoch`: its key now, or the one it had before a re-key. */
    private fun keyAt(id: String, epoch: Long): ByteArray = if (node(id).keyEpoch == epoch) keyOf(id) else previousKeys[id to epoch] ?: keyOf(id)

    /* A node's key, unwrapped from the envelopes the server holds, from its workspace key down. */
    fun keyOf(id: String): ByteArray = synchronized(lock) {
        val node = node(id)
        val parentKey = node.parentId?.let { keyAt(it, node.parentKeyEpoch) } ?: workspaceKeys.getValue(node.workspaceId)
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

    /* What the server holds now, served again when the returned call runs: a server replaying an older copy (a rollback). */
    fun settingsSnapshot(): () -> Unit = synchronized(lock) {
        val document = settingsDocument
        val version = settingsVersion
        return@synchronized { synchronized(lock) { settingsDocument = document; settingsVersion = version } }
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
    private class Rotation(val ws: String, val target: Long, val applied: HashSet<String> = HashSet(), var finished: Boolean = false)
    private val rotations = HashMap<String, Rotation>()

    /*
     * A key change running from `nodeId` to `target`, as a manager's member list change leaves one in a family folder: its
     * top folder already re-keyed (applied), the rest for any member to walk.
     */
    fun startRun(nodeId: String, target: Long) = synchronized(lock) {
        rotations[nodeId] = Rotation(node(nodeId).workspaceId, target, hashSetOf(nodeId))
    }

    /*
     * Another device of the owner, walking the run from `runRoot`, re-keys `id` first, as its own batch would: a fresh key
     * wrapped under its parent's key (at the target below the run's top, as it is for the top), its name sealed again
     * under it and signed by the owner. Its children stay where they were, under its key before.
     */
    fun rekeyedElsewhere(runRoot: String, id: String) = synchronized(lock) {
        val rotation = rotations.getValue(runRoot)
        val node = node(id)
        val ws = node.workspaceId
        val old = keyOf(id)
        previousKeys[id to node.keyEpoch] = old
        if (node.previous == null) node.previous = Triple(node.keyEnvelope, node.keyEpoch, node.parentKeyEpoch)
        val fresh = randomBytes(32u)
        val parentEpoch = if (id == runRoot) node.parentKeyEpoch else rotation.target
        val metadata = metadataOpen(MetadataContext(ws, id, node.metadataVersion.toULong()), old, base64urlDecode(node.metadataEnvelope))
        val sealed = metadataSeal(MetadataContext(ws, id, node.metadataVersion.toULong()), fresh, metadata)
        node.keyEnvelope = base64urlEncode(nodeWrap(NodeKeyContext(ws, id, node.parentId ?: ws, parentEpoch.toULong(), rotation.target.toULong()),
            node.parentId?.let { keyAt(it, parentEpoch) } ?: workspaceKeys.getValue(ws), fresh))
        node.parentKeyEpoch = parentEpoch
        node.keyEpoch = rotation.target
        node.metadataEnvelope = base64urlEncode(sealed)
        node.signature = base64urlEncode(metadataSign(owners.getValue(ws).keys.signingSeed,
            MetadataStatement(ws, id, if (node.kind == "folder") NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion.toULong()), sealed))
        node.signer = owners.getValue(ws).id
        node.metadataRekey = null
        bump(node)
        rotation.applied.add(id)
    }

    /* Runs as a rotation send arrives, before anything of it is applied (another device's batch landing first). */
    @Volatile var beforeRotationSend: ((ids: List<String>) -> Unit)? = null

    /* Whether the run from `nodeId` is still running (route 25 names it). */
    fun running(nodeId: String): Boolean = synchronized(lock) { rotations[nodeId]?.finished == false }

    /* The nodes a run re-keyed so far. */
    fun appliedIn(nodeId: String): Set<String> = synchronized(lock) { rotations[nodeId]?.applied?.toSet().orEmpty() }

    private fun answer(exchange: HttpExchange) {
        val method = exchange.requestMethod
        val path = exchange.requestURI.rawPath
        val query = (exchange.requestURI.rawQuery ?: "").split("&").filter { it.contains("=") }
            .associate { it.substringBefore("=") to URLDecoder.decode(it.substringAfter("="), "UTF-8") }
        val raw = exchange.requestBody.readBytes()
        requests.add("$method $path")
        clients.add("$method $path" to exchange.requestHeaders.getFirst("HushOS-Client"))
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
        .put("children", JSONArray(children(folder.id).filter { it.trashedAt == null }.map { it.json() })).put("nextCursor", JSONObject.NULL)
    private fun objectUrl(objectId: String) = "$origin/store/objects/$objectId"
    private fun versionById(id: String): Pair<Node, Version>? = nodes.values.firstNotNullOfOrNull { n -> n.version?.takeIf { it.id == id }?.let { n to it } }
    private fun bump(node: Node) { node.changeSeq = changeSeq++ }
    /* The folders above `node`, its parent first. */
    private fun above(node: Node): List<Node> = generateSequence(node.parentId?.let { nodes[it] }) { it.parentId?.let { id -> nodes[id] } }.toList()

    private fun route(method: String, path: String, query: Map<String, String>, body: JSONObject, linkToken: String?): Pair<Int, JSONObject>? {
        val segments = path.trim('/').split("/")
        extraRoutes?.invoke(method, segments, query, body)?.let { return it }
        fun at(vararg pattern: String) = segments.size == pattern.size && pattern.indices.all { pattern[it] == "*" || pattern[it] == segments[it] }
        val get = method == "GET"
        val post = method == "POST"
        return when {
            // The account's own routes (Auth.call).
            get && at("auth", "identity") -> ok(JSONObject().put("identity", Auth.json(me.envelope)))
            get && at("auth", "identity", "history") -> ok(JSONObject().put("identities", JSONArray()))
            get && at("auth", "settings") -> {
                if (failSettingsOnceWorkListed && workListed) return 500 to JSONObject().put("message", "Settings are unavailable")
                if (failSettingsReads) return 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
                settingsReadAnswer?.let { return it }
                val answer = settingsJson()
                onNextSettingsGet?.let { hook -> onNextSettingsGet = null; hook() }
                ok(answer)
            }
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
                onSettingsPut?.invoke()
                if (loseNextSettingsAnswer) { loseNextSettingsAnswer = false; return 500 to JSONObject().put("message", "The answer was lost") }
                ok(JSONObject().put("settingsVersion", settingsVersion))
            }
            post && at("auth", "contacts", "lookup") -> {
                lookups++
                if (failLookups) return 500 to JSONObject().put("message", "Lookups are down")
                others[body.getString("email").lowercase()]?.let { (person, name) ->
                    return ok(JSONObject().put("contact", person.served.toJson().put("userId", person.id).put("name", name).put("email", body.getString("email"))))
                }
                if (!body.getString("email").equals("grace@example.org", ignoreCase = true)) return 404 to JSONObject().put("message", "No HushOS account uses that email.")
                ok(JSONObject().put("contact", grace.served.toJson().put("userId", grace.id).put("name", "Grace Hopper").put("email", "grace@example.org")))
            }
            get && at("auth", "contacts", "*", "succession") -> ok(JSONObject().put("links", JSONArray()))
            post && at("drive", "nodes", "*", "shares") -> {
                val share = JSONObject().put("id", UUID.randomUUID().toString()).put("role", body.getString("role")).put("keyEpoch", body.getLong("keyEpoch"))
                    .put("createdAt", "2026-10-30T00:00:00Z").put("suite", 4)
                    .put("grantee", JSONObject().put("id", body.getString("granteeUserId")).put("name", "Grace Hopper").put("email", "grace@example.org"))
                sharesMade.add(share)
                ok(JSONObject().put("share", share))
            }
            get && at("drive", "workspaces", "*", "trash") -> ok(JSONObject().put("items", JSONArray(nodes.values.filter { it.trashedAt != null }.map { node ->
                JSONObject().put("node", node.json()).put("ancestors", JSONArray(above(node).reversed().map { it.json() }))
                    .put("parentTrashed", above(node).any { it.trashedAt != null })
            })).put("nextCursor", JSONObject.NULL))

            get && at("drive", "workspace") -> ok(JSONObject().put("workspaceId", workspace).put("changeSeq", changeSeq).put("grant", grant).put("root", node(root).json()))
            // The feed is state, not a log: each node changed since the cursor once, as it is now.
            get && at("drive", "workspaces", "*", "changes") -> {
                // A client paging the feed in a loop fails here rather than hanging the test.
                if (++changesServed > 500) return 500 to JSONObject().put("message", "Too many feed requests")
                if (changePagesLeft == 0) return 500 to JSONObject().put("message", "The connection dropped")
                changePagesLeft?.let { changePagesLeft = it - 1 }
                val since = query.getValue("since").toInt()
                val limit = minOf(query.getValue("limit").toInt(), changesPage ?: Int.MAX_VALUE)
                val changed = nodes.values.filter { it.workspaceId == segments[2] && it.changeSeq > since && it.id !in missedByFeed }.sortedBy { it.changeSeq }
                val page = changed.take(limit)
                ok(JSONObject().put("changes", JSONArray(page.map { JSONObject().put("kind", "node").put("changeSeq", it.changeSeq).put("node", it.json()) }))
                    .put("nextCursor", page.maxOfOrNull { it.changeSeq } ?: since).put("hasMore", changed.size > page.size)
                    // As the server answers a cursor older than the newest tombstone it dropped; zero is starting over already.
                    .put("resync", since in 1 until tombstonesDroppedThrough))
            }
            post && at("drive", "nodes", "*", "parent") -> {
                val node = node(segments[2])
                node.parentId = body.getString("parentId")
                node.parentKeyEpoch = body.getLong("parentKeyEpoch")
                node.keyEnvelope = body.getString("keyEnvelope")
                bump(node)
                ok(JSONObject().put("node", node.json()))
            }
            post && at("drive", "nodes", "*", "trash") -> { trash(segments[2]); ok(JSONObject()) }
            // The batch Undo: each id back where it was.
            post && at("drive", "workspaces", "*", "restore-batch") -> {
                val ids = body.getJSONArray("nodeIds")
                val results = JSONArray()
                for (i in 0 until ids.length()) {
                    val node = node(ids.getString(i))
                    node.trashedAt = null
                    bump(node)
                    results.put(JSONObject().put("id", node.id).put("status", "restored").put("changeSeq", node.changeSeq))
                }
                ok(JSONObject().put("results", results))
            }
            // Back where it was (a trash's Undo; no move under the top folder here).
            post && at("drive", "nodes", "*", "restore") -> {
                val node = node(segments[2])
                node.trashedAt = null
                bump(node)
                ok(JSONObject().put("node", node.json()))
            }
            get && at("drive", "nodes", "*", "children") -> {
                val folder = nodes[segments[2]]?.takeIf { it.workspaceId == query["workspaceId"] } ?: return 404 to JSONObject().put("message", "Not found")
                // Nothing under a trashed folder is listed (packages/db listChildren): 409 `trashed`.
                if (above(folder).any { it.trashedAt != null } || folder.trashedAt != null)
                    return 409 to JSONObject().put("code", "trashed").put("message", "This item is in the trash. Restore it first.")
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
                // A rotation still running is resumed, as the server keeps its target and what it applied.
                val rotation = rotations[segments[2]]?.takeIf { !it.finished } ?: Rotation(body.getString("workspaceId"), nextEpoch++)
                rotations[segments[2]] = rotation
                ok(JSONObject().put("rotation", JSONObject().put("targetEpoch", rotation.target)))
            }
            get && at("drive", "nodes", "*", "rotation", "work") -> {
                val rotation = rotations.getValue(segments[2])
                workListed = true
                // Parents first: the subtree breadth first, less what was applied.
                val order = ArrayList<Node>()
                val queue = ArrayDeque(listOf(node(segments[2])))
                while (queue.isNotEmpty()) queue.removeFirst().also { order.add(it); queue.addAll(children(it.id)) }
                val todo = order.filter { it.id !in rotation.applied }
                if (todo.isEmpty()) rotation.finished = true
                val batch = rotationBatch?.let { todo.take(it) } ?: todo
                val work = batch.map { node ->
                    node.json().put("versions", JSONArray(listOfNotNull(node.version).map { v ->
                        JSONObject().put("id", v.id).put("objectId", v.objectId).put("contentSuite", v.suite.toInt()).put("contentKeyEnvelope", v.contentKeyEnvelope)
                            .put("plaintextSize", JSONObject.NULL).put("signer", JSONObject().put("id", v.signer)).put("signature", v.signature)
                    })).put("shares", JSONArray(rotationShares[node.id].orEmpty())).put("links", JSONArray())
                }
                ok(JSONObject().put("rotation", JSONObject().put("targetEpoch", rotation.target)).put("nodes", JSONArray(work))
                    .put("nextCursor", if (batch.size < todo.size) "more" else JSONObject.NULL).put("done", todo.isEmpty()))
            }
            post && at("drive", "nodes", "*", "rotation", "nodes") -> {
                val send = ++rotationSends
                val wires = body.getJSONArray("nodes")
                rotationBatches.add((0 until wires.length()).map { wires.getJSONObject(it).getString("id") })
                if (failRotationSend || send in failRotationSends) return 500 to JSONObject().put("message", "The connection dropped")
                beforeRotationSend?.invoke(rotationBatches.last())
                val rotation = rotations.getValue(segments[2])
                val results = JSONArray()
                for (i in 0 until wires.length()) {
                    val wire = wires.getJSONObject(i)
                    val node = node(wire.getString("id"))
                    // A node sent at a change order the server has moved past (another device's walk applied it): stale.
                    if (!wire.isNull("changeSeq") && wire.optInt("changeSeq") != node.changeSeq) { results.put(JSONObject().put("id", node.id).put("status", "stale")); continue }
                    // Below the run's top: the parent must be re-keyed already, and at the epoch the node was wrapped under
                    // (packages/db rotateNodeIn). Each node is judged on its own, so a batch can land in part.
                    if (node.id != segments[2] && node.parentId != null) {
                        val parent = node(node.parentId!!)
                        if (parent.keyEpoch < rotation.target) { results.put(JSONObject().put("id", node.id).put("status", "parent-not-ready")); continue }
                        if (parent.keyEpoch != wire.getLong("parentKeyEpoch")) { results.put(JSONObject().put("id", node.id).put("status", "stale")); continue }
                    }
                    val rotated = wire.optJSONObject("rotated")
                    // Its key before, kept for the children the walk hasn't reached: they are still wrapped under it.
                    if (rotated != null) {
                        previousKeys[node.id to node.keyEpoch] = keyOf(node.id)
                        if (node.previous == null) node.previous = Triple(node.keyEnvelope, node.keyEpoch, node.parentKeyEpoch)
                    }
                    node.parentKeyEpoch = wire.getLong("parentKeyEpoch")
                    node.keyEnvelope = wire.getString("keyEnvelope")
                    rotated?.let {
                        node.keyEpoch = rotation.target
                        // A re-keyed record keeps its writer's origin (carried from an earlier walk, or the record as it was).
                        fun origin(kept: JSONObject?, envelope: String, signer: String, signature: String, sent: JSONObject) =
                            JSONObject().put("origin", JSONObject(kept?.getJSONObject("origin")?.toString() ?: JSONObject().put("envelope", envelope)
                                .put("signer", JSONObject().put("id", signer)).put("signature", signature).toString()).put("keyEnvelope", sent.getString("originKeyEnvelope")))
                                .put("signature", sent.getString("signature"))
                        val metaRekey = rotated.optJSONObject("metadataRekey")
                        if (metaRekey != null) node.metadataRekey = origin(node.metadataRekey, node.metadataEnvelope, node.signer, node.signature, metaRekey)
                        else node.metadataRekey = null
                        node.metadataEnvelope = rotated.getString("metadataEnvelope")
                        node.signature = if (rotated.isNull("metadataSignature")) "" else rotated.getString("metadataSignature")
                        node.signer = userId
                        val versions = rotated.getJSONArray("versions")
                        for (j in 0 until versions.length()) {
                            val v = versions.getJSONObject(j)
                            node.version?.takeIf { it.id == v.getString("id") }?.let { version ->
                                val rekey = v.optJSONObject("rekey")
                                version.rekey = rekey?.let { origin(version.rekey, version.contentKeyEnvelope, version.signer, version.signature, it) }
                                version.contentKeyEnvelope = v.getString("contentKeyEnvelope")
                                version.signature = if (v.isNull("signature")) "" else v.optString("signature")
                                version.signer = userId
                            }
                        }
                    }
                    bump(node)
                    rotation.applied.add(node.id)
                    results.put(JSONObject().put("id", node.id).put("status", "ok"))
                }
                if (send in loseRotationAnswers) return 500 to JSONObject().put("message", "The connection dropped")
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
