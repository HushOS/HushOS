package com.hushos.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.hushos.core.Content
import com.hushos.core.MetadataContext
import com.hushos.core.NodeKeyContext
import com.hushos.core.NodeMetadata
import com.hushos.core.VersionContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.checkName
import com.hushos.core.chunkDecrypt
import com.hushos.core.chunkEncrypt
import com.hushos.core.chunkLength
import com.hushos.core.chunkRange
import com.hushos.core.contentLayout
import com.hushos.core.deviceRestore
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.nodeOpen
import com.hushos.core.nodeWrap
import com.hushos.core.randomBytes
import com.hushos.core.thumbnailDecrypt
import com.hushos.core.thumbnailEncrypt
import com.hushos.core.thumbnailRange
import com.hushos.core.versionOpen
import com.hushos.core.IdentityKeys
import com.hushos.core.ShareContext
import com.hushos.core.identityOpen
import com.hushos.core.shareOpen
import com.hushos.core.LinkContext
import com.hushos.core.linkCreate
import com.hushos.core.linkSecretOpen
import com.hushos.core.linkUrl
import com.hushos.core.base64urlEncode
import com.hushos.core.recoveryPhrase
import com.hushos.core.settingsOpen
import com.hushos.core.settingsSeal
import com.hushos.core.shareSeal
import com.hushos.core.identityFingerprint
import com.hushos.core.versionReseal
import com.hushos.core.ContentKey
import com.hushos.core.versionSeal
import com.hushos.core.workspaceOpen
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.util.UUID

/* A node with its metadata opened: what every list, row and provider cursor is built from. */
data class Opened(val node: NodeView, val metadata: NodeMetadata) {
    val id get() = node.id
    val name get() = metadata.name
    val isFolder get() = node.isFolder
    val size: Long? get() = if (isFolder) null else metadata.size?.toLong() ?: node.currentVersion?.plaintextSize?.toLongOrNull()
    val modifiedMillis: Long? get() = (metadata.modified ?: node.updatedAt)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val hasThumbnail get() = !isFolder && node.currentVersion?.contentSuite == 2u
}

/* A trashed node opened, and whether its old folder is in the trash too. */
data class TrashItem(val item: Opened, val parentTrashed: Boolean)

data class OpenedVersion(val content: Content, val versionId: String) {
    val layout get() = contentLayout(content.plaintextSize, content.thumbnailBytes)
}

/*
 * The keys, opened on demand and kept while the process lives: the account key
 * from the remembered device, the workspace key from the grant, node keys under
 * their parents. A node-to-parent index persists so a document id the system
 * asks about cold is found by listing the folder it was last seen in.
 */
class Vault(private val context: Context, val api: DriveApi) {
    private var accountKey: ByteArray? = null
    private var workspace: WorkspaceView? = null
    private var workspaceKey: ByteArray? = null
    /* The tree mirror on disk and the catalogue built from it (see Catalogue.kt). */
    internal val mirror = Mirror.shared(context)
    @Volatile internal var catalogueState: CatalogueState = CatalogueState.IDLE
    /* One sync or build at a time; the maps below are read from many threads while one of them writes. */
    internal val syncLock = Any()
    internal val catalogueChildren = ConcurrentHashMap<String, MutableSet<String>>()
    internal val nodeKeys = ConcurrentHashMap<String, ByteArray>()
    private var identity: IdentityKeys? = null
    internal val opened = ConcurrentHashMap<String, Opened>()
    private val indexFile = File(context.filesDir, "files-parents.json")
    internal val parents: ConcurrentHashMap<String, String> = ConcurrentHashMap<String, String>().also { map ->
        runCatching {
            val json = JSONObject(indexFile.readText())
            for (key in json.keys()) map[key] = json.getString(key)
        }
    }

    companion object {
        fun fromShared(context: Context): Vault? = Shared.session(context)?.let { Vault(context, DriveApi(it)) }
    }

    private fun saveIndex() {
        val json = JSONObject()
        for ((k, v) in parents) json.put(k, v)
        runCatching { indexFile.writeText(json.toString()) }
    }

    internal fun rememberParent(id: String, parent: String) {
        if (parents[id] == parent) return
        parents[id] = parent
        saveIndex()
    }

    private fun unlockAccount(): ByteArray {
        accountKey?.let { return it }
        val device = Shared.device(context) ?: throw NotAuthenticated()
        return deviceRestore(device.bundle, device.deviceKey).also { accountKey = it }
    }

    @Synchronized
    fun loadWorkspace(): WorkspaceView {
        workspace?.let { return it }
        // Kept sealed in the mirror, so a start without network still opens the drive.
        val key = "workspace:${api.session.userId}"
        val json = try {
            api.workspaceJson().also { mirror.putDocument(key, it.toString()) }
        } catch (error: Unreachable) {
            mirror.document(key)?.let { JSONObject(it) } ?: throw error
        }
        val view = api.workspace(json)
        val grant = view.grant ?: throw ApiError(404, "No workspace grant")
        workspaceKey = workspaceOpen(api.session.userId, unlockAccount(), grant.grant)
        workspace = view
        return view
    }

    val rootId: String get() = loadWorkspace().root?.id ?: throw NotFound("This drive has no root yet.")
    fun workspaceKey(): ByteArray { loadWorkspace(); return workspaceKey ?: throw ApiError(500, "Workspace not opened") }
    val workspaceId: String get() = loadWorkspace().workspaceId

    fun nodeKey(id: String): ByteArray? = nodeKeys[id]

    /* Whether `folder` is `ancestor` itself or lies below it, as far as the tree has been opened. */
    fun descends(folder: String, ancestor: String): Boolean {
        var cursor: String? = folder
        var steps = 0
        while (cursor != null && steps < 256) {
            if (cursor == ancestor) return true
            cursor = parents[cursor] ?: opened[cursor]?.node?.parentId
            steps++
        }
        return false
    }

    /* The identity's private keys, opened once under the account key. */
    internal fun identityKeys(): IdentityKeys = identity ?: identityOpen(api.session.userId, unlockAccount(), Auth.identity(context)).also { identity = it }

    /* The links the owner made for this item. */
    fun links(item: Opened): List<LinkView> = api.links(item.id, item.node.workspaceId)

    /* Mints a link for an item this account holds the key of; returns it with the URL to hand out. */
    fun createLink(item: Opened, password: String?, expiresAt: Instant?): Pair<LinkView, String> {
        val nodeKey = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val ctx = LinkContext(item.node.workspaceId, item.id, item.node.keyEpoch, UUID.randomUUID().toString())
        val created = linkCreate(ctx, nodeKey, password)
        val body = JSONObject().put("workspaceId", item.node.workspaceId).put("linkId", ctx.linkId).put("token", created.token)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("linkEnvelope", created.linkEnvelope).put("linkSalt", created.linkSalt)
            .put("secretEnvelope", created.secretEnvelope).put("hasPassword", created.hasPassword)
            .put("expiresAt", expiresAt?.toString() ?: JSONObject.NULL)
        val link = api.createLink(item.id, body)
        return link to linkUrl(api.session.origin, created.token, created.secret)
    }

    /* The URL of an existing link, from the owner's sealed copy of its secret; null for one made before it was kept. */
    fun linkUrlOf(link: LinkView, item: Opened): String? {
        val nodeKey = nodeKeys[item.id] ?: return null
        val sealed = link.secretEnvelope ?: return null
        val owned = linkSecretOpen(LinkContext(item.node.workspaceId, item.id, link.keyEpoch, link.id), nodeKey, base64urlDecode(sealed))
        return linkUrl(api.session.origin, base64urlEncode(owned.token), base64urlEncode(owned.secret))
    }

    fun revokeLink(link: LinkView, item: Opened) = api.revokeLink(link.id, item.node.workspaceId)

    /* Files a report on an item shared with this account; the session names the reporter. */
    fun report(item: Opened, category: String, reason: String, email: String?): Boolean {
        val nodeKey = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val operators = PublicApi(api.session.origin).operators()
        return api.fileReport(Reports.body(operators, item, nodeKey, category, reason, email, JSONObject().put("share", true)))
    }

    // Contacts and shares to people

    fun loadSettings(): Settings {
        val keys = identityKeys()
        val envelope = Auth.settings(context) ?: return Settings(HashMap(), 0uL)
        val json = JSONObject(settingsOpen(keys.encryptionPrivateKey, api.session.userId, envelope))
        val contacts = HashMap<String, ContactPin>()
        val entries = json.getJSONObject("contacts")
        for (key in entries.keys()) contacts[key] = ContactPin.from(entries.getJSONObject(key))
        return Settings(contacts, envelope.settingsVersion)
    }

    private fun saveSettings(settings: Settings) {
        val keys = identityKeys()
        val contacts = JSONObject()
        for ((id, pin) in settings.contacts) contacts.put(id, pin.toJson())
        val json = JSONObject().put("version", 1).put("contacts", contacts).toString()
        Auth.putSettings(context, settings.version, settingsSeal(keys.encryptionPrivateKey, api.session.userId, settings.version + 1uL, json))
    }

    /* Everyone pinned, newest first. */
    fun contacts(): List<ContactPin> = loadSettings().contacts.values.sortedByDescending { it.pinnedAt }

    /* This account's own fingerprint, for the other person to check. */
    fun ownFingerprint(): String = identityFingerprint(base64urlDecode(identityKeys().encryptionPublicKey))

    /* A person by email, with what the pin says about them. */
    fun lookup(email: String): Lookup {
        val contact = Auth.lookupContact(context, email)
        val pinned = loadSettings().contacts[contact.userId]
        var changed = false
        if (pinned != null) {
            if (pinned.encryptionPublicKey != contact.encryptionPublicKey) changed = true
            if (pinned.kemPublicKeyHash != null && pinned.kemPublicKeyHash != contact.kemHash) changed = true
        }
        return Lookup(contact, pinned, changed)
    }

    /* Trusts the keys shown now: what the person does after checking the fingerprint. */
    fun pin(contact: Contact) {
        val pin = ContactPin(contact.userId, contact.email, contact.name, contact.encryptionPublicKey, contact.signingPublicKey,
            contact.fingerprint, Instant.now().toString(), if (contact.kemSigned) contact.kemHash else null)
        val settings = loadSettings()
        settings.contacts[contact.userId] = pin
        runCatching { saveSettings(settings) }.onFailure {
            // Changed on another device meanwhile: read again and retry once.
            val latest = loadSettings()
            latest.contacts[contact.userId] = pin
            saveSettings(latest)
        }
    }

    fun unpin(pin: ContactPin) {
        val settings = loadSettings()
        settings.contacts.remove(pin.userId)
        saveSettings(settings)
    }

    fun shares(item: Opened): List<OwnedShare> = api.shares(item.id, item.node.workspaceId)

    /*
     * Shares an item with a pinned contact: the served keys must match the pin
     * (a first, signed post-quantum key is accepted and remembered), then the
     * node key is sealed to them with this identity's private key.
     */
    fun share(item: Opened, pin: ContactPin, role: String): OwnedShare {
        val nodeKey = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val contact = Auth.lookupContact(context, pin.email)
        if (contact.userId != pin.userId || contact.encryptionPublicKey != pin.encryptionPublicKey) throw ContactChanged()
        var kemPublic: ByteArray? = null
        if (contact.kemPublicKey != null && contact.kemSigned) {
            val hash = contact.kemHash
            if (pin.kemPublicKeyHash != null) {
                if (pin.kemPublicKeyHash != hash) throw ContactChanged()
            } else {
                val settings = loadSettings()
                settings.contacts[pin.userId]?.let { settings.contacts[pin.userId] = it.copy(kemPublicKeyHash = hash); saveSettings(settings) }
            }
            kemPublic = base64urlDecode(contact.kemPublicKey)
        } else if (pin.kemPublicKeyHash != null) throw ContactChanged()
        val keys = identityKeys()
        val ctx = ShareContext(item.node.workspaceId, item.id, item.node.keyEpoch, pin.userId, api.session.userId)
        val envelope = shareSeal(ctx, nodeKey, keys.encryptionPrivateKey, base64urlDecode(pin.encryptionPublicKey), kemPublic)
        return api.createShare(item.id, JSONObject().put("workspaceId", item.node.workspaceId).put("granteeUserId", pin.userId).put("role", role)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("shareEnvelope", base64urlEncode(envelope)))
    }

    fun revokeShare(share: OwnedShare, item: Opened) = api.revokeShare(share.id, item.node.workspaceId)

    /* Rotates the subtree under `item` after a revoke; returns how many nodes were re-sealed. */
    fun rotate(item: Opened, progress: (Int) -> Unit = {}): Int = rotateSubtree(item, progress)

    internal fun openedNodes(): Map<String, Opened> = HashMap(opened)
    internal fun workspaceKeyBytes(): ByteArray? = workspaceKey
    internal fun rememberKey(id: String, key: ByteArray) { nodeKeys[id] = key }
    internal fun forgetAll() { opened.clear() }

    /*
     * A copy into another workspace (a shared folder): the server keeps objects
     * per workspace, so the file is fetched and uploaded again, thumbnail and
     * all. Folders go node by node.
     */
    fun copyAcross(id: String, parentId: String, progress: (Float) -> Unit = {}): Opened {
        val source = resolve(id)
        if (source.isFolder) {
            val made = createFolder(parentId, source.name)
            for (child in listChildren(source.id)) copyAcross(child.id, made.id, progress)
            return made
        }
        val directory = File(context.cacheDir, "copy-" + UUID.randomUUID())
        try {
            val file = File(directory, source.name)
            download(source.id, file) { progress(it / 2f) }
            val thumb = runCatching { thumbnail(source.id) }.getOrNull()
            return upload(file, source.name, source.metadata.mime, parentId, null, thumb) { progress(0.5f + it / 2f) }
        } finally {
            directory.deleteRecursively()
        }
    }

    /* Opens a node of this workspace by listing the folder it sits in, which opens the whole chain above. */
    private fun openAnywhere(node: NodeView): Opened? {
        opened[node.id]?.let { return it }
        runCatching { listChildren(node.parentId ?: rootId) }
        return opened[node.id] ?: runCatching { open(node) }.getOrNull()
    }

    /* Everything this account shared out: to people, and by link. */
    fun sharedByMe(): List<SharedByMe> {
        val (shares, links) = api.sharedByMe()
        return shares.map { (share, node) -> SharedByMe("share-" + share.id, openAnywhere(node), node, share, null) } +
            links.map { (link, node) -> SharedByMe("link-" + link.id, openAnywhere(node), node, null, link) }
    }

    /* Keeps a file: downloads its current version into the offline store and records it. */
    fun keepDownloaded(item: Opened, progress: (Float) -> Unit = {}) {
        val destination = Offline.file(context, item) ?: throw ApiError(400, "Only files can be kept downloaded.")
        if (!destination.exists()) {
            // Renamed elsewhere: the same version is already here under its old name, so move it rather than fetch it again.
            val earlier = destination.parentFile?.listFiles()?.firstOrNull { it.isFile && !it.name.endsWith(".part") }
            if (earlier == null || !earlier.renameTo(destination)) {
                try {
                    download(item.id, destination, null, progress)
                } catch (error: Exception) {
                    // A first keep that failed is nobody's to resume: its partial goes. A kept file's stays for the next refresh.
                    if (!Offline.isKept(context, item.id)) File(Offline.root(context), item.id).deleteRecursively()
                    throw error
                }
            }
        }
        // Older versions of the same file go; only the current one is kept.
        destination.parentFile?.parentFile?.listFiles()?.filter { it.name != item.node.currentVersion?.id }?.forEach { it.deleteRecursively() }
        Offline.remember(context, item)
    }

    /* Brings the named kept files up to their current version (replaced elsewhere: fetched again; trashed: forgotten); returns the ids that failed. */
    fun refreshOffline(ids: Collection<String>, progress: (String, Float) -> Unit = { _, _ -> }): Set<String> {
        val failed = HashSet<String>()
        for (entry in Offline.entries(context).filter { it.id in ids }) {
            val item = runCatching { resolve(entry.id) }.getOrNull()
            if (item == null) { failed.add(entry.id); continue }
            if (item.isFolder || item.node.trashedAt != null) { Offline.forget(context, entry.id); continue }
            if (Offline.localCopy(context, item) == null && runCatching { keepDownloaded(item) { progress(entry.id, it) } }.isFailure) failed.add(entry.id)
        }
        return failed
    }

    /* The 24 words again, for someone who holds the account key and wants to check their copy. */
    fun recoveryPhrase(): String = recoveryPhrase(api.session.userId, unlockAccount(), Auth.recoveryKey(context))

    /* The workspace a node lives in: a share's subtree belongs to the granter's. */
    private fun workspaceOf(nodeId: String): String = opened[nodeId]?.node?.workspaceId ?: workspaceId

    /* A share as received, with its root opened under the key the granter sealed to this identity. */
    data class ShareMount(val share: ShareView, val root: Opened?, val error: String?)

    fun mountShares(): List<ShareMount> {
        val shares = api.sharedWithMe()
        if (shares.isEmpty()) return emptyList()
        val keys = identityKeys()
        return shares.map { share ->
            runCatching {
                val key = shareOpen(base64urlDecode(share.shareEnvelope), base64urlDecode(share.granterPublicKey), keys,
                    ShareContext(share.workspaceId, share.node.id, share.keyEpoch, api.session.userId, share.granterId))
                val metadata = metadataOpen(MetadataContext(share.node.workspaceId, share.node.id, share.node.metadataVersion), key, base64urlDecode(share.node.metadataEnvelope))
                ShareMount(share, adopt(share.node, key, metadata), null)
            }.getOrElse { ShareMount(share, null, it.message ?: "This share could not be opened.") }
        }
    }
    fun item(id: String): Opened? = opened[id]

    private fun parentKeyFor(node: NodeView): ByteArray {
        val parentId = node.parentId ?: node.workspaceId
        if (parentId == node.workspaceId) return workspaceKey ?: throw ApiError(500, "Workspace not opened")
        return nodeKeys[parentId] ?: throw ApiError(500, "Open the containing folder first.")
    }

    @Synchronized
    fun open(node: NodeView): Opened {
        opened[node.id]?.let { return it }
        val ctx = NodeKeyContext(node.workspaceId, node.id, node.parentId ?: node.workspaceId, node.parentKeyEpoch, node.keyEpoch)
        val key = nodeOpen(ctx, parentKeyFor(node), base64urlDecode(node.keyEnvelope))
        nodeKeys[node.id] = key
        val metadata = metadataOpen(MetadataContext(node.workspaceId, node.id, node.metadataVersion), key, base64urlDecode(node.metadataEnvelope))
        val result = Opened(node, metadata)
        opened[node.id] = result
        node.parentId?.let { parents[node.id] = it }
        return result
    }

    private fun adopt(node: NodeView, key: ByteArray, metadata: NodeMetadata): Opened {
        nodeKeys[node.id] = key
        val result = Opened(node, metadata)
        opened[node.id] = result
        node.parentId?.let { rememberParent(node.id, it) }
        return result
    }

    fun forget(id: String) {
        opened.remove(id)
    }

    /* Every page of a folder, every key along the way opened; parents first, folders before files. */
    fun listChildren(folderId: String): List<Opened> {
        // The catalogue answers first when it can, so a folder draws before the server is asked.
        catalogueChildren(folderId)?.let { return it }
        val ws = workspaceOf(folderId)
        var after: String? = null
        val children = ArrayList<Opened>()
        do {
            val page = api.children(folderId, ws, after)
            // Above a share's root the keys are the granter's; those ancestors stay closed.
            page.ancestors.forEach { runCatching { open(it) } }
            open(page.folder)
            for (child in page.children) {
                children.add(open(child))
                parents[child.id] = folderId
            }
            after = page.nextCursor
        } while (after != null)
        saveIndex()
        return children.sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    fun resolve(id: String): Opened {
        opened[id]?.let { return it }
        if (id == rootId) listChildren(id) else parents[id]?.let { listChildren(it) }
            ?: throw ApiError(500, "This item has not been seen yet; open its folder first.")
        return opened[id] ?: throw NotFound("This item no longer exists.")
    }

    fun openVersion(item: Opened, version: VersionListView? = null): OpenedVersion {
        val key = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val current = item.node.currentVersion
        val id = version?.id ?: current?.id ?: throw NotFound("This file has no content yet.")
        val objectId = version?.objectId ?: current!!.objectId
        val envelope = version?.contentKeyEnvelope ?: current!!.contentKeyEnvelope
        val suite = version?.contentSuite ?: current!!.contentSuite
        val nonce = version?.contentNonce ?: current!!.contentNonce
        val rowSize = (version?.plaintextSize ?: current?.plaintextSize)?.toULongOrNull()
        val opened = versionOpen(VersionContext(item.node.workspaceId, item.id, id, objectId), suite, key, base64urlDecode(envelope), rowSize)
        val content = Content(item.node.workspaceId, objectId, suite, opened.key, base64urlDecode(nonce), opened.plaintextSize, opened.thumbnailBytes)
        return OpenedVersion(content, id)
    }

    /* Downloads and decrypts a file's version into `destination`, chunk by chunk, resuming a `.part` an earlier try left. */
    fun download(id: String, destination: File, version: VersionListView? = null, progress: (Float) -> Unit = {}) {
        val item = resolve(id)
        val v = openVersion(item, version)
        var url = api.versionUrl(v.versionId, item.node.workspaceId)
        Resumable.download(destination, v.layout.chunkCount, v.layout.chunkBytes.toLong(),
            online = { Resumable.online(context) }, progress = progress,
            onExpired = { url = api.versionUrl(v.versionId, item.node.workspaceId) },
        ) { index -> chunkDecrypt(v.content, index, api.range(url, chunkRange(v.content.plaintextSize, index))) }
    }

    fun thumbnail(id: String): ByteArray? {
        val item = resolve(id)
        if (!item.hasThumbnail) return null
        val v = openVersion(item)
        if (v.content.thumbnailBytes == 0u) return null
        val ciphertext = mirror.thumbnail(v.versionId) ?: run {
            val url = api.thumbnailUrl(v.versionId, item.node.workspaceId) ?: return null
            api.range(url, thumbnailRange(v.content.plaintextSize, v.content.thumbnailBytes)).also { mirror.putThumbnail(v.versionId, it) }
        }
        return thumbnailDecrypt(v.content, ciphertext)
    }

    fun trash(): List<TrashItem> {
        catalogueTrash()?.let { return it }
        val ws = workspaceId
        var after: String? = null
        val result = ArrayList<TrashItem>()
        do {
            val page = api.trashListing(ws, after)
            for (entry in page.items) {
                entry.ancestors.forEach { runCatching { open(it) } }
                forget(entry.node.id)
                runCatching { open(entry.node) }.onSuccess { result.add(TrashItem(it, entry.parentTrashed)) }
            }
            after = page.nextCursor
        } while (after != null)
        return result
    }

    /* The most recently changed files, from the tail of the change feed. */
    fun recents(limit: Int = 60): List<Opened> {
        catalogueRecents(limit)?.let { return it }
        val view = loadWorkspace()
        val feed = api.changes(view.workspaceId, maxOf(0, view.changeSeq - 400), 400)
        val latest = LinkedHashMap<String, NodeView>()
        for (change in feed.changes) {
            if (change.kind != "node") continue
            val node = change.node ?: continue
            if (node.isFolder || node.trashedAt != null || node.currentVersion == null) { latest.remove(node.id); continue }
            latest[node.id] = node
        }
        val items = ArrayList<Opened>()
        for (node in latest.values) {
            node.parentId?.let { rememberParent(node.id, it) }
            forget(node.id)
            runCatching { resolve(node.id) }.onSuccess { items.add(it) }
        }
        return items.sortedByDescending { it.modifiedMillis ?: 0 }.take(limit)
    }

    fun versions(id: String): List<VersionListView> = api.versions(id, resolve(id).node.workspaceId)

    // Writes

    fun createFolder(parentId: String, name: String): Opened {
        // Shared folders belong to the granter's workspace; an editor writes there.
        val ws = workspaceOf(parentId)
        val parent = resolve(parentId)
        val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
        val epoch = api.allocateEpoch(ws)
        val id = UUID.randomUUID().toString()
        val key = randomBytes(32u)
        val wrapped = nodeWrap(NodeKeyContext(ws, id, parent.id, parent.node.keyEpoch, epoch), parentKey, key)
        val metadata = NodeMetadata(checkName(name), null, null, null)
        val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, metadata)
        val node = api.createFolder(ws, JSONObject().put("id", id).put("parentId", parent.id).put("keyEpoch", epoch.toLong())
            .put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEnvelope", base64urlEncode(wrapped)).put("metadataEnvelope", base64urlEncode(sealed)))
        return adopt(node, key, metadata)
    }

    fun rename(id: String, name: String): Opened {
        val item = resolve(id)
        val key = nodeKeys[id] ?: throw ApiError(500, "Node not opened")
        val metadata = item.metadata.copy(name = name)
        val sealed = metadataSeal(MetadataContext(item.node.workspaceId, id, item.node.metadataVersion + 1uL), key, metadata)
        val node = api.rename(id, item.node.workspaceId, item.node.metadataVersion, item.node.keyEpoch, base64urlEncode(sealed))
        return adopt(node, key, metadata)
    }

    private fun rewrap(item: Opened, parent: Opened): String {
        val key = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
        return base64urlEncode(nodeWrap(NodeKeyContext(item.node.workspaceId, item.id, parent.id, parent.node.keyEpoch, item.node.keyEpoch), parentKey, key))
    }

    fun move(id: String, parentId: String): Opened {
        val item = resolve(id)
        val parent = resolve(parentId)
        val key = nodeKeys[id] ?: throw ApiError(500, "Node not opened")
        val node = api.move(id, item.node.workspaceId, parent.id, parent.node.keyEpoch, rewrap(item, parent))
        return adopt(node, key, item.metadata)
    }

    /* A copy under `parentId`: the server keeps the object; the envelopes are resealed here under a fresh node key. Folders go node by node. */
    fun copy(id: String, parentId: String, name: String? = null): Opened {
        val source = resolve(id)
        val parent = resolve(parentId)
        val ws = workspaceOf(parentId)
        val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
        val newName = checkName(name ?: source.name)
        if (source.isFolder) {
            val made = createFolder(parent.id, newName)
            for (child in listChildren(source.id)) copy(child.id, made.id)
            return made
        }
        val version = source.node.currentVersion ?: throw NotFound("This file has no content yet.")
        val opened = openVersion(source)
        val epoch = api.allocateEpoch(ws)
        val newId = UUID.randomUUID().toString()
        val versionId = UUID.randomUUID().toString()
        val key = randomBytes(32u)
        val keyEnvelope = nodeWrap(NodeKeyContext(ws, newId, parent.id, parent.node.keyEpoch, epoch), parentKey, key)
        val metadata = source.metadata.copy(name = newName)
        val metadataEnvelope = metadataSeal(MetadataContext(ws, newId, 1uL), key, metadata)
        val contentKeyEnvelope = versionReseal(
            VersionContext(ws, newId, versionId, version.objectId), version.contentSuite, key,
            ContentKey(opened.content.key, opened.content.plaintextSize, opened.content.thumbnailBytes),
        )
        val node = api.copy(source.id, ws, JSONObject().put("sourceVersionId", version.id)
            .put("node", JSONObject().put("id", newId).put("parentId", parent.id).put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEpoch", epoch.toLong())
                .put("keyEnvelope", base64urlEncode(keyEnvelope)).put("metadataEnvelope", base64urlEncode(metadataEnvelope)))
            .put("versionId", versionId).put("contentKeyEnvelope", base64urlEncode(contentKeyEnvelope)))
        return adopt(node, key, metadata)
    }

    fun trash(id: String) {
        val item = resolve(id)
        api.trash(id, item.node.workspaceId)
        forget(id)
    }

    fun restore(entry: TrashItem): Opened {
        val item = opened[entry.item.id] ?: open(entry.item.node)
        val key = nodeKeys[item.id] ?: throw ApiError(500, "Node not opened")
        val toRoot = if (entry.parentTrashed) resolve(rootId).let { root -> root.node.keyEpoch to rewrap(item, root) } else null
        val node = api.restore(item.id, item.node.workspaceId, toRoot)
        return adopt(node, key, item.metadata)
    }

    fun purge(id: String) {
        api.purge(id, workspaceId)
        forget(id)
    }

    fun emptyTrash() = api.emptyTrash(workspaceId)

    fun restoreVersion(version: VersionListView, id: String): Opened {
        val item = resolve(id)
        val key = nodeKeys[id] ?: throw ApiError(500, "Node not opened")
        return adopt(api.restoreVersion(version.id, item.node.workspaceId), key, item.metadata)
    }

    /* A small JPEG for the lists and the picker, as the web makes one at upload; null when not an image or too big. */
    fun makeThumbnail(file: File, mime: String?): ByteArray? {
        if (mime?.startsWith("image/") != true) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > 512 || bounds.outHeight / sample > 512) sample *= 2
        val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val scale = minOf(1f, 256f / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true) else bitmap
        // JPEG has no alpha: transparent images sit on the sheet colour, not on black.
        val small = Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888).also { flat ->
            val canvas = android.graphics.Canvas(flat)
            canvas.drawColor(0xFFFCFBF7.toInt())
            canvas.drawBitmap(scaled, 0f, 0f, null)
        }
        for (quality in intArrayOf(70, 50, 30)) {
            val out = ByteArrayOutputStream()
            small.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= 65_536) return out.toByteArray()
        }
        return null
    }

    /* A file's bytes as a new node under `parentId`, or a new version of `replacing`; a thumbnail rides after the last chunk. */
    fun upload(file: File, name: String, mime: String?, parentId: String, replacing: Opened?, thumbnail: ByteArray? = null, progress: (Float) -> Unit = {}): Opened {
        val ws = workspaceOf(parentId)
        val size = file.length().toULong()
        val modified = Instant.ofEpochMilli(file.lastModified()).toString()
        val versionId = UUID.randomUUID().toString()
        val objectId = UUID.randomUUID().toString()
        val contentKey = randomBytes(32u)
        val contentNonce = randomBytes(16u)
        val thumbnailBytes = (thumbnail?.size ?: 0).toUInt()
        val nodeId: String
        val nodeKey: ByteArray
        val nodeInput: JSONObject
        val metadata: NodeMetadata
        if (replacing != null) {
            nodeId = replacing.id
            nodeKey = nodeKeys[nodeId] ?: throw ApiError(500, "Node not opened")
            nodeInput = JSONObject().put("existing", true).put("id", nodeId).put("keyEpoch", replacing.node.keyEpoch.toLong())
                .put("expectedVersionId", replacing.node.currentVersion?.id ?: JSONObject.NULL)
            metadata = replacing.metadata
        } else {
            val parent = resolve(parentId)
            val parentKey = nodeKeys[parent.id] ?: throw ApiError(500, "Open the containing folder first.")
            val epoch = api.allocateEpoch(ws)
            nodeId = UUID.randomUUID().toString()
            nodeKey = randomBytes(32u)
            val wrapped = nodeWrap(NodeKeyContext(ws, nodeId, parent.id, parent.node.keyEpoch, epoch), parentKey, nodeKey)
            metadata = NodeMetadata(checkName(name), mime, size, modified)
            val sealed = metadataSeal(MetadataContext(ws, nodeId, 1uL), nodeKey, metadata)
            nodeInput = JSONObject().put("existing", false).put("id", nodeId).put("parentId", parent.id).put("keyEpoch", epoch.toLong())
                .put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEnvelope", base64urlEncode(wrapped)).put("metadataEnvelope", base64urlEncode(sealed))
        }
        val version = versionSeal(VersionContext(ws, nodeId, versionId, objectId), nodeKey, contentKey, size, thumbnailBytes)
        val content = Content(ws, objectId, 2u, contentKey, contentNonce, size, thumbnailBytes)
        val layout = version.layout
        val begun = api.beginUpload(ws, JSONObject().put("node", nodeInput).put("versionId", versionId).put("objectId", objectId)
            .put("contentKeyEnvelope", base64urlEncode(version.envelope)).put("contentNonce", base64urlEncode(contentNonce))
            .put("contentSuite", 2).put("chunkCount", layout.chunkCount.toLong()).put("ciphertextSize", layout.ciphertextSize.toString()))
        val urls = HashMap<Int, String>()
        for (part in begun.parts) urls[part.partNumber] = part.url
        val etags = JSONArray()
        try {
            RandomAccessFile(file, "r").use { raf ->
                for (index in 0uL until layout.chunkCount) {
                    val partNumber = index.toInt() + 1
                    if (!urls.containsKey(partNumber)) for (part in api.partUrls(begun.uploadId, ws, partNumber)) urls[part.partNumber] = part.url
                    val length = chunkLength(size, index).toInt()
                    val plaintext = ByteArray(length)
                    raf.seek((index * layout.chunkBytes).toLong())
                    raf.readFully(plaintext)
                    var sealed = chunkEncrypt(content, index, plaintext)
                    if (index == layout.chunkCount - 1uL && thumbnail != null && thumbnailBytes > 0u) sealed += thumbnailEncrypt(content, thumbnail)
                    // A part the network dropped is sent again; an expired address is fetched fresh first.
                    val etag = Resumable.run(online = { Resumable.online(context) }, onExpired = {
                        urls.remove(partNumber)
                        for (part in api.partUrls(begun.uploadId, ws, partNumber)) urls[part.partNumber] = part.url
                    }) {
                        if (!urls.containsKey(partNumber)) for (part in api.partUrls(begun.uploadId, ws, partNumber)) urls[part.partNumber] = part.url
                        api.putPart(urls[partNumber] ?: throw ApiError(500, "No URL for part $partNumber"), sealed)
                    }
                    etags.put(JSONObject().put("partNumber", partNumber).put("etag", etag))
                    progress((index + 1uL).toFloat() / layout.chunkCount.toFloat())
                }
            }
        } catch (error: Exception) {
            api.abortUpload(begun.uploadId, ws)
            throw error
        }
        var node = api.completeUpload(begun.uploadId, ws, etags) ?: throw ApiError(500, "Upload completed without a node")
        var final = metadata
        if (replacing != null) {
            // A new version has a new size and date; the sealed metadata says so too, as the lists read it.
            final = metadata.copy(mime = mime ?: metadata.mime, size = size, modified = modified)
            val sealed = metadataSeal(MetadataContext(ws, nodeId, node.metadataVersion + 1uL), nodeKey, final)
            node = api.rename(nodeId, ws, node.metadataVersion, node.keyEpoch, base64urlEncode(sealed))
        }
        return adopt(node, nodeKey, final)
    }
}
