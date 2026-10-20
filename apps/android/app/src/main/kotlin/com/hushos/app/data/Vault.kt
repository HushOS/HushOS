package com.hushos.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.hushos.core.Content
import com.hushos.core.linkReseal
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
import com.hushos.core.recoveryPhrase
import com.hushos.core.settingsOpen
import com.hushos.core.settingsSeal
import com.hushos.core.shareSeal
import com.hushos.core.versionReseal
import com.hushos.core.ContentKey
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.VersionStatement
import com.hushos.core.contentSuite
import com.hushos.core.Integrity
import com.hushos.core.settingsKeyCreate
import com.hushos.core.settingsKeyOpen
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
data class Opened(
    val node: NodeView, val metadata: NodeMetadata,
    /* The current version's size as sealed in its own envelope: true after a restore, when the metadata still describes the newer upload. */
    val contentSize: Long? = null,
) {
    val id get() = node.id
    val name get() = metadata.name
    val isFolder get() = node.isFolder
    val size: Long? get() = if (isFolder) null else contentSize ?: metadata.size?.toLong() ?: node.currentVersion?.plaintextSize?.toLongOrNull()
    /*
     * When it changed: the file's own date from its metadata, unless the metadata describes
     * another version than the current one (an earlier version was restored), when the
     * node's last change (the restore) is the honest answer.
     */
    val modifiedMillis: Long? get() {
        val stale = contentSize != null && metadata.size != null && metadata.size!!.toLong() != contentSize
        val at = if (stale) node.updatedAt ?: metadata.modified else metadata.modified ?: node.updatedAt
        return at?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    }
    /* When it last changed in HushOS (an upload, a rename, a move), whatever the file's own date: what Recent goes by, as on the web. */
    val changedMillis: Long? get() = node.updatedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    /* Suites 2 and 3 carry a thumbnail trailer when the sealed size says so; suite 1 never does. */
    val hasThumbnail get() = !isFolder && (node.currentVersion?.contentSuite ?: 0u) >= 2u
}

/*
 * Recent: newest first; things changed in the same moment by name, then id, as the web orders
 * them, so the list never reshuffles between loads.
 */
val byRecent: Comparator<Opened> = compareByDescending<Opened> { it.changedMillis ?: 0L }
    .thenBy(java.text.Collator.getInstance()) { it.name }
    .thenBy { it.id }

/*
 * A row as every list, link and provider cursor shows it: the node, its metadata, and the
 * current version's size from that version's own envelope. After a restore the metadata
 * still describes the newer upload; the envelope is what the file is now.
 */
internal fun openedRow(node: NodeView, metadata: NodeMetadata, key: ByteArray) = Opened(node, metadata, sealedSize(node, key))

/* The current version's size from its own envelope, or null when it doesn't open with this key. */
internal fun sealedSize(node: NodeView, key: ByteArray): Long? {
    val version = node.currentVersion ?: return null
    if (node.isFolder) return null
    return runCatching {
        versionOpen(VersionContext(node.workspaceId, node.id, version.id, version.objectId), version.contentSuite, key,
            base64urlDecode(version.contentKeyEnvelope), version.plaintextSize?.toULongOrNull()).plaintextSize.toLong()
    }.getOrNull()
}

/* A trashed node opened, whether its old folder is in the trash too, and that folder's name ("Files" for the top). */
data class TrashItem(val item: Opened, val parentTrashed: Boolean, val wasIn: String? = null)

data class OpenedVersion(val content: Content, val versionId: String) {
    /* The object's layout: suite 3 is padded, so it has more chunks than the file's bytes fill; the trailing ones decrypt to nothing. */
    val layout get() = contentLayout(content.suite, content.plaintextSize, content.thumbnailBytes)
}

/*
 * The keys, opened on demand and kept while the process lives: the account key
 * from the remembered device, the workspace key from the grant, node keys under
 * their parents. A node-to-parent index persists so a document id the system
 * asks about cold is found by listing the folder it was last seen in.
 */
class Vault(internal val context: Context, val api: DriveApi) {
    private var accountKey: ByteArray? = null
    private var workspace: WorkspaceView? = null
    private var workspaceKey: ByteArray? = null
    /* The tree mirror on disk and the catalogue built from it (see Catalogue.kt). */
    internal val mirror = Mirror.shared(context)
    @Volatile internal var catalogueState: CatalogueState = CatalogueState.IDLE
    /* The catalogue holds what the server sent this session, not only what the phone had: a node missing from it is gone. */
    @Volatile internal var cataloguePulled = false
    /* One sync or build at a time; the maps below are read from many threads while one of them writes. */
    internal val syncLock = Any()
    internal val catalogueChildren = ConcurrentHashMap<String, MutableSet<String>>()
    /* Node keys and rows by (workspace, node): a share's keys never answer for this account's own nodes (NodeCache). */
    internal val nodes = NodeCache { workspace?.workspaceId }
    /* The identity in use and the earlier ones, opened once and kept until forgotten (see OpenedIdentities). */
    private val ownIdentities = OpenedIdentities(
        open = {
            openOwnIdentity(api.session.userId, unlockAccount(), SettingsMark.of(context),
                served = { Auth.identity(context) },
                store = { Auth.upgradeIdentity(context, it) },
                upgraded = { ShareSeals.of(context).lastPass = 0L },
            )
        },
        // Each opened under the account key, which proves it is this account's own, not one the server added.
        history = { Auth.identityHistory(context).mapNotNull { runCatching { identityOpen(api.session.userId, unlockAccount(), it) }.getOrNull() }.reversed() },
    )
    /* The settings key, opened under the account key once the server served it (or this device made it). */
    private var settingsKey: ByteArray? = null
    private val indexFile = File(context.filesDir, "files-parents.json")
    internal val parents: ConcurrentHashMap<String, String> = ConcurrentHashMap<String, String>().also { map ->
        runCatching {
            val json = JSONObject(indexFile.readText())
            for (key in json.keys()) map[key] = json.getString(key)
        }
    }

    init {
        api.onBadSignature = { forgetIdentity() }
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
        var view = api.workspace(json)
        val grant = view.grant ?: throw ApiError(404, "No workspace grant")
        val wsKey = workspaceOpen(api.session.userId, unlockAccount(), grant.grant)
        workspaceKey = wsKey
        // Never opened on any device: the top folder is made here, once, for the app, the Files app and the queue alike.
        if (view.root == null) {
            val parentEpoch = grant.grant.workspaceKeyVersion
            val ws = view.workspaceId
            view = ensureRoot(view, parentEpoch, api, seal = { id, epoch, parentKeyEpoch ->
                val key = randomBytes(32u)
                val wrapped = nodeWrap(NodeKeyContext(ws, id, ws, parentKeyEpoch, epoch), wsKey, key)
                val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, NodeMetadata(ROOT_NAME, null, null, null))
                SealedRoot(base64urlEncode(wrapped), base64urlEncode(sealed), signMetadata(ws, id, NodeKind.FOLDER, 1uL, sealed))
            })
            runCatching { mirror.putDocument(key, api.workspaceJson().toString()) }
        }
        workspace = view
        return view
    }

    val rootId: String get() = loadWorkspace().root?.id ?: throw NotFound("This drive has no root yet.")
    fun workspaceKey(): ByteArray { loadWorkspace(); return workspaceKey ?: throw ApiError(500, "Workspace not opened") }
    val workspaceId: String get() = loadWorkspace().workspaceId

    /* Whether `folder` is `ancestor` itself or lies below it, as far as the tree has been opened. */
    fun descends(folder: String, ancestor: String): Boolean {
        var cursor: String? = folder
        var steps = 0
        while (cursor != null && steps < 256) {
            if (cursor == ancestor) return true
            cursor = parents[cursor] ?: nodes.find(cursor)?.node?.parentId
            steps++
        }
        return false
    }

    /*
     * The identity's private keys, opened once under the account key (see openOwnIdentity): a version 1 identity is
     * upgraded to version 2 here, before anything is signed with it, since the server refuses signed writes from a
     * version 1 identity. One served as current with a lower key version than this device already opened, or in its
     * version 1 form once this device has seen version 2, is refused. After this device's own upgrade the re-seal pass
     * runs at the next Drive open, to seal the ledger's shares in suite 4 where pins allow.
     */
    internal fun identityKeys(): IdentityKeys = ownIdentities.current()

    private fun forgetIdentity() = ownIdentities.forget()

    internal fun identities(strict: Boolean = false): List<IdentityKeys> = ownIdentities.all(strict)

    /*
     * The signing keys this device trusts and for whom: its own (the current one, and the earlier ones as retired) and
     * every checked contact's. Throws when any of it can't load (the history, the settings, settings refused as rolled
     * back): the caller shows every record as unchecked, and a rotation or copy stops, never treating it as clean.
     */
    fun trust(): Trust {
        val all = identities(strict = true)
        return Trust.of(api.session.userId, base64urlDecode(all[0].signingPublicKey), all.drop(1).map { base64urlDecode(it.signingPublicKey) }, loadSettings().contacts)
    }

    /* The trust set for a write that re-signs what it copies or rotates: without it nothing is locked again. */
    internal fun trustForWrite(): Trust = try {
        trust()
    } catch (error: NotAuthenticated) {
        throw error
    } catch (error: Unreachable) {
        throw error
    } catch (error: Exception) {
        throw TrustUnavailable(error)
    }

    /*
     * The writer's signature over a metadata envelope (docs/integrity-design.md, section 2): every write that sets one
     * sends it. `prior` is set when the envelope re-seals a record that existed before (a copy, a rotation): its
     * verdict as it was. Only a verified record is signed with the ordinary statement; anything else is re-sealed, so
     * re-locking never vouches for who wrote it. A record that could not be checked is not re-signed at all.
     */
    internal fun signMetadata(workspaceId: String, nodeId: String, kind: NodeKind, metadataVersion: ULong, envelope: ByteArray, prior: Integrity? = null): String =
        base64urlEncode(metadataSignature(identityKeys().signingSeed, MetadataStatement(workspaceId, nodeId, kind, metadataVersion), envelope, prior))

    /* The writer's signature over a content-key envelope, in the suite of the object it opens; `prior` as for metadata. */
    internal fun signVersion(workspaceId: String, nodeId: String, versionId: String, objectId: String, suite: UInt, envelope: ByteArray, prior: Integrity? = null): String =
        base64urlEncode(versionSignature(identityKeys().signingSeed, VersionStatement(workspaceId, nodeId, versionId, objectId, suite), envelope, prior))

    /* A copy's signature over its new metadata envelope, by where it came from (Prior). */
    private fun signCopiedMetadata(workspaceId: String, nodeId: String, kind: NodeKind, envelope: ByteArray, copy: Prior): String =
        base64urlEncode(copyMetadataSignature(identityKeys().signingSeed, MetadataStatement(workspaceId, nodeId, kind, 1uL), envelope, copy))

    /* A copy's signature over its new content-key envelope. */
    private fun signCopiedVersion(workspaceId: String, nodeId: String, versionId: String, objectId: String, suite: UInt, envelope: ByteArray, copy: Prior): String =
        base64urlEncode(copyVersionSignature(identityKeys().signingSeed, VersionStatement(workspaceId, nodeId, versionId, objectId, suite), envelope, copy))

    /* The links the owner made for this item. */
    fun links(item: Opened): List<LinkView> = api.links(item.id, item.node.workspaceId)

    /* Mints a link for an item this account holds the key of; returns it with the URL to hand out. Recorded in the ledger once the server took it. */
    fun createLink(item: Opened, password: String?, expiresAt: Instant?): Pair<LinkView, String> {
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val linkId = IdField.LINK.mint(item.node.workspaceId)
        val ctx = LinkContext(item.node.workspaceId, item.id, item.node.keyEpoch, linkId.id)
        val created = linkCreate(ctx, nodeKey, password)
        val body = JSONObject().put("workspaceId", item.node.workspaceId).putId(linkId).put("token", created.token)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("linkEnvelope", created.linkEnvelope).put("linkSalt", created.linkSalt)
            .put("secretEnvelope", created.secretEnvelope).put("hasPassword", created.hasPassword)
            .put("expiresAt", expiresAt?.toString() ?: JSONObject.NULL)
        val link = api.createLink(item.id, body)
        updateSettings { it.addLink(ctx.linkId, item.id) }
        return link to linkUrl(api.session.origin, created.token, created.secret)
    }

    /* The URL of an existing link, from the owner's sealed copy of its secret; null for one made before it was kept. A link of an older derivation is refused. */
    fun linkUrlOf(link: LinkView, item: Opened): String? {
        LinkKdf.check(link.kdfVersion)
        val nodeKey = nodes.key(item) ?: return null
        val sealed = link.secretEnvelope ?: return null
        val owned = linkSecretOpen(LinkContext(item.node.workspaceId, item.id, link.keyEpoch, link.id), nodeKey, base64urlDecode(sealed))
        return linkUrl(api.session.origin, base64urlEncode(owned.token), base64urlEncode(owned.secret))
    }

    /* Out of the ledger first (saved before the server hears of it), so no rotation ever seals it again. */
    fun revokeLink(link: LinkView, item: Opened) {
        updateSettings { it.removeLink(link.id) }
        api.revokeLink(link.id, item.node.workspaceId)
    }

    /*
     * Changes a link's password (`password`: null keeps it, "" removes it) and or its
     * end date (`expiresAt`: null keeps it, Optional.empty() clears it). A new password
     * reseals the same secret, so the address people already have keeps working.
     */
    fun updateLink(link: LinkView, item: Opened, password: String?, expiresAt: java.util.Optional<Instant>?): LinkView {
        val body = JSONObject().put("workspaceId", item.node.workspaceId).put("keyEpoch", link.keyEpoch.toLong())
        if (password != null) {
            LinkKdf.check(link.kdfVersion)
            val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
            val sealed = link.secretEnvelope ?: throw ApiError(409, "This link can’t be changed. Turn it off and make a new one.")
            val made = linkReseal(LinkContext(item.node.workspaceId, item.id, link.keyEpoch, link.id), nodeKey, base64urlDecode(sealed), password.ifEmpty { null })
            body.put("seal", JSONObject().put("linkEnvelope", made.linkEnvelope).put("linkSalt", made.linkSalt)
                .put("hasPassword", made.hasPassword).put("secretEnvelope", made.secretEnvelope))
        }
        if (expiresAt != null) body.put("expiresAt", expiresAt.map<Any> { it.toString() }.orElse(JSONObject.NULL))
        return api.updateLink(link.id, body)
    }

    /* Deletes an earlier version of a file for good. */
    fun discardVersion(item: Opened, version: VersionListView) = api.discardVersion(version.id, item.node.workspaceId)

    /* Files a report on an item shared with this account; the session names the reporter. */
    fun report(item: Opened, category: String, reason: String, email: String?): Boolean {
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val operators = PublicApi(api.session.origin).operators()
        return api.fileReport(Reports.body(operators, item, nodeKey, category, reason, email, JSONObject().put("share", true)))
    }

    // Contacts and shares to people

    /* The settings key the server holds, opened under the account key; null until some device stored one. */
    private fun openSettingsKey(stored: Auth.StoredSettings): ByteArray? {
        settingsKey?.let { return it }
        val wrapped = stored.key ?: return null
        return settingsKeyOpen(api.session.userId, unlockAccount(), wrapped).also { settingsKey = it }
    }

    /*
     * The settings key for the next save: the stored one, or a new one wrapped under the account key and stored first
     * (once per account; a device that raced reads the one that won and uses that).
     */
    private fun settingsKeyForSave(): ByteArray {
        settingsKey?.let { return it }
        val stored = Auth.settings(context)
        openSettingsKey(stored)?.let { return it }
        val made = settingsKeyCreate(api.session.userId, unlockAccount())
        try {
            Auth.putSettingsKey(context, made.envelope)
        } catch (error: AuthFailure) {
            if (error.status != 409) throw error
            return openSettingsKey(Auth.settings(context)) ?: throw error
        }
        settingsKey = made.key
        return made.key
    }

    /*
     * The settings as the server holds them, refused when older than this device has seen (see readServedSettings).
     * Version 2 opens under the settings key. Version 1 (sealed under a key off the identity, which a stolen identity
     * key opened) no longer opens: it reads as no settings at its stored sequence, and the next save goes over it.
     */
    fun loadSettings(): Settings {
        val mark = SettingsMark.of(context)
        val userId = api.session.userId
        // A mark an earlier app kept per identity carries over first, so the per-account one never starts lower.
        mark.settingsSeen(userId, identityKeys().encryptionPublicKey)
        val stored = Auth.settings(context)
        return readServedSettings(userId, stored.envelope, stored.sequence, mark) {
            openSettingsKey(stored) ?: throw AuthFailure("Your settings key is missing. Sign in again.")
        }
    }

    /*
     * Compare-and-set: read, change, seal one version up, save over the version read. Another device
     * saving in between is a 409: read again and apply the change again, up to three tries. The JSON
     * is edited in place, so fields this app doesn't know (the web's, a later client's) survive.
     */
    internal fun updateSettings(change: (Settings) -> Unit): Settings {
        val key = settingsKeyForSave()
        var attempt = 0
        while (true) {
            val settings = loadSettings()
            change(settings)
            val next = settings.version + 1uL
            try {
                // Always version 2, under the settings key: a version 1 document is moved over by its first save here.
                // Named over the stored sequence and sealed at one above it, the version the server stores it at.
                Auth.putSettings(context, settings.version, settingsSeal(api.session.userId, key, next, settings.text()))
                // Always version 2: from here on, no document at all is a rollback.
                SettingsMark.of(context).recordSettings(api.session.userId, next, sealedV2 = true)
                return Settings(settings.json, next)
            } catch (error: AuthFailure) {
                if (error.status != 409 || ++attempt >= 3) throw error
            }
        }
    }

    /* Everyone pinned, newest first. */
    fun contacts(): List<ContactPin> = loadSettings().contacts.values.sortedByDescending { it.pinnedAt }

    /* This account's own fingerprint, for the other person to check. */
    fun ownFingerprint(): String = ownFingerprint(identityKeys())

    /*
     * The words for Your twelve words, as of now: the served identity is read first, and when it is not the one this
     * process opened (the keys were replaced on another device), that one is forgotten and the served one opened, so
     * the words are those of the identity the server serves at this moment, re-derived from its private halves. It
     * needs the server: offline it fails rather than show words it can't confirm are current, and a 401 ends the session.
     */
    fun currentOwnFingerprint(): String = ownFingerprint(ownIdentities.current(Auth.identity(context)))

    /*
     * A person by email, with what the pin says about them. "Check it's them": the one place a pinned contact's served keys are followed through their succession chain
     * (docs/integrity-design.md, "Who sees whom"), because the person asked. Nothing else follows them on its own.
     */
    fun lookup(email: String): Lookup {
        val contact = Auth.lookupContact(context, email)
        val pinned = loadSettings().contacts[contact.userId] ?: return Lookup(contact, null, changed = false)
        val comparison = comparePin(pinned, contact.served)
        // New keys signed by the pinned ones: the pin follows them, and People says so rather than warning.
        if (comparison == PinComparison.SUCCESSION) followPin(pinned, contact.served)?.let { return Lookup(contact, it, changed = false, followed = true) }
        // A changed key, or a chain that does not hold: the words no longer vouch for the account.
        val changed = comparison == PinComparison.CHANGED || comparison == PinComparison.SUCCESSION
        // A pin from before the release (or never checked) over keys that did not change: "Check words again".
        return Lookup(contact, pinned, changed, recheck = !changed && !pinned.verified)
    }

    /*
     * Trusts the keys shown now: what the person does after comparing the words. Writes the version 3 pin of the served
     * keys (both digests and the fingerprint over all four), and only for an upgraded identity whose keys statement
     * holds: words are never compared over fewer keys. The earlier keys a succession vouched for stay only when the
     * words were compared over the same keys again (the notice after a succession); a different key accepted by hand
     * vouches for none of them. Shares to them may now be sealed in suite 4, so the re-seal pass runs next.
     */
    fun pin(contact: Contact) {
        val fresh = ContactPin.ofServed(contact.userId, contact.email, contact.name, contact.served, Instant.now().toString())
            ?.takeIf { contact.upgraded }
            ?: throw AuthFailure("${contact.name.ifEmpty { contact.email }} needs to sign in to HushOS once more before you can compare words.")
        updateSettings { settings ->
            val before = settings.contacts[contact.userId]
            val moved = before != null && (before.encryptionPublicKey != contact.encryptionPublicKey || before.signingPublicKey != contact.signingPublicKey)
            settings.pin(fresh.copy(previousSigningKeys = if (before != null && !moved) before.previousSigningKeys else emptyList()))
        }
        ShareSeals.of(context).lastPass = 0L
    }

    /*
     * A pinned contact whose served keys differ: their whole succession chain, checked link by link; the pin follows
     * it and is saved when it holds. Null when it doesn't, or can't be asked: the changed-key warning stands. Only
     * "Check it's them" calls this. A share to them sealed to the old keys is sealed again at the next pass.
     */
    private fun followPin(pin: ContactPin, served: ServedIdentity): ContactPin? {
        if (comparePin(pin, served) != PinComparison.SUCCESSION) return null
        val links = runCatching { Auth.succession(context, pin.userId) }.getOrNull() ?: return null
        val next = followSuccession(pin, served, links, Instant.now().toString()) ?: return null
        updateSettings { settings ->
            // Another device may have followed (or re-pinned) first: only a pin still at the old keys is moved.
            val now = settings.contacts[pin.userId]
            if (now == null || (now.encryptionPublicKey == pin.encryptionPublicKey && now.signingPublicKey == pin.signingPublicKey)) settings.pin(next)
        }
        ShareSeals.of(context).lastPass = 0L
        return next
    }

    fun unpin(pin: ContactPin) {
        updateSettings { it.unpin(pin.userId) }
    }

    fun shares(item: Opened): List<OwnedShare> = api.shares(item.id, item.node.workspaceId)

    /*
     * Shares an item with a pinned contact: the pin must be version 3 (words compared over all four keys) and the
     * served keys the pinned ones, the ML-KEM key by its digest (granteeKem). Only then is the node key sealed to them,
     * in suite 4 (hybrid, signed with both halves of this account's identity), and the share goes in the ledger once
     * the server took it.
     */
    fun share(item: Opened, pin: ContactPin, role: String): OwnedShare {
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        // The pin as the settings hold it now, not as the sheet last read it.
        val current = loadSettings().contacts[pin.userId] ?: throw SharingRefused("Add ${pin.displayName} in People you share with before you share with them.")
        val contact = Auth.lookupContact(context, current.email)
        if (contact.userId != current.userId) throw ContactChanged()
        // Other keys than the pinned ones are never followed here: replaced or changed, the person checks them again first.
        val kem = granteeKem(current, contact.served)
        val keys = identityKeys()
        val ctx = ShareContext(item.node.workspaceId, item.id, item.node.keyEpoch, current.userId, api.session.userId)
        // Suite 4: a fresh X25519 key and ML-KEM to the pinned keys, signed by this account's Ed25519 and ML-DSA keys.
        val envelope = shareSeal(ctx, nodeKey, keys, base64urlDecode(current.encryptionPublicKey), kem)
        val share = api.createShare(item.id, JSONObject().put("workspaceId", item.node.workspaceId).put("granteeUserId", current.userId).put("role", role)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("shareEnvelope", base64urlEncode(envelope)))
        ShareSeals.of(context).record(mapOf(share.id to ShareSeals.Seal(keys.keyVersion, contact.keyVersion)))
        updateSettings { it.addShare(item.id, current.userId) }
        return share
    }

    /* Out of the ledger first (saved before the revoke and the rotation after it), so no rotation seals to them again. */
    fun revokeShare(share: OwnedShare, item: Opened) {
        updateSettings { it.removeShare(item.id, share.granteeId) }
        api.revokeShare(share.id, item.node.workspaceId)
    }

    /*
     * Replaces this account's sharing keys (X25519, Ed25519, ML-KEM) by a succession the current signing key signs
     * (docs/integrity-design.md, section 4): people who checked the old words follow it without comparing again. The
     * settings move to their own key first if they are still sealed under the identity, the new identity is stored,
     * opened (the old one joins the history, which still opens what was shared to it), and every share in the ledger
     * is sealed again in suite 4 under the new keys. Returns how many shares were sealed again and who was left out.
     */
    fun replaceSharingKeys(progress: (done: Int, total: Int) -> Unit = { _, _ -> }): RotationResult {
        val userId = api.session.userId
        // A succession is signed with both halves: a version 1 identity is upgraded first.
        val opened = identityKeys()
        // Signed over the identity opened, never over whatever the server serves now.
        val succession = try {
            succeedOwnIdentity(userId, unlockAccount(), opened, Auth.identity(context))
        } catch (error: IdentityMoved) {
            forgetIdentity()
            throw error
        }
        Auth.succeedIdentity(context, succession)
        // From here the shares wait to be sealed again: a pass cut short is finished on the next Drive open, never by minting again.
        ShareSeals.of(context).pending = succession.identity.keyVersion
        forgetIdentity()
        val keys = identityKeys()
        if (keys.signingPublicKey != succession.identity.signingPublicKey) throw ApiError(502, "HushOS answered with other keys than the new ones. Try again.")
        // The keys are replaced from here on, whatever happens next: a failure below is said, not undone or retried by minting again.
        return try {
            resealLedgerShares(progress)
        } catch (error: Exception) {
            if (error is NotAuthenticated) throw error
            RotationResult(0, listOf("Your shares weren’t sealed again under the new keys yet. They’re tried again the next time you open HushOS."))
        }
    }

    /*
     * The re-seal pass: every share in the ledger that needs it (see needsReseal) is sealed again with this account's
     * current identity, in suite 4, only to version 3 pins that vouch for the keys served now, never to X25519 alone. It finishes
     * a key replacement that failed or was cut short, upgrades older suites, and seals to grantees whose replaced keys
     * the person checked again. It follows nobody on its own, and looks up only the grantees of shares it seals. What
     * it sealed is recorded (ShareSeals); a pass with no failures clears the waiting replacement and is not run again
     * for a day.
     */
    internal fun resealLedgerShares(progress: (done: Int, total: Int) -> Unit = { _, _ -> }): RotationResult {
        val seals = ShareSeals.of(context)
        val settings = loadSettings()
        val ledger = settings.ledger
        val pins = settings.contacts
        val keys = identityKeys()
        val skipped = LinkedHashSet<String>()
        val served = HashMap<String, Contact?>()
        val todo = ledger.shares.filterValues { it.isNotEmpty() }
        var done = 0
        var failed = 0
        progress(0, todo.size)
        for ((index, entry) in todo.entries.withIndex()) {
            val (nodeId, people) = entry
            try {
                // A node gone from the drive has nothing left to share; its ledger entry goes with its next revoke.
                val item = runCatching { resolve(nodeId) }.getOrNull()?.takeIf { it.node.workspaceId == workspaceId && it.node.trashedAt == null } ?: continue
                val nodeKey = nodes.key(item) ?: continue
                val rows = api.shares(item.id, item.node.workspaceId).filter { it.granteeId in people }
                val wire = rows.mapNotNull { share ->
                    // Someone no longer pinned, or not found now, keeps the envelope they have.
                    val pin = pins[share.granteeId] ?: return@mapNotNull null
                    if (!needsReseal(share.suite, seals.get(share.id), keys.keyVersion, pin.keyVersion)) return@mapNotNull null
                    // The post-quantum key to seal to is only in a lookup; keys other than the pin's are left out by the plan.
                    val contact = served.getOrPut(share.granteeId) { runCatching { Auth.lookupContact(context, pin.email) }.getOrNull() }
                    val grantee = contact?.takeIf { it.userId == share.granteeId } ?: return@mapNotNull null
                    JSONObject().put("id", share.id).put("granteeUserId", share.granteeId).put("grantee", grantee.served.toJson())
                }
                val plan = planReseal(item.id, wire, emptyList(), ledger, pins)
                skipped.addAll(plan.skipped)
                for (share in plan.shares) {
                    val ctx = ShareContext(item.node.workspaceId, item.id, item.node.keyEpoch, share.granteeUserId, api.session.userId)
                    api.resealShare(share.id, item.node.workspaceId, item.node.keyEpoch, base64urlEncode(shareSeal(ctx, nodeKey, keys, share.publicKey, share.kemPublicKey)))
                    // Sealed to the pinned keys, which are the ones served at this version.
                    seals.record(mapOf(share.id to ShareSeals.Seal(keys.keyVersion, pins[share.granteeUserId]?.keyVersion ?: served[share.granteeUserId]?.keyVersion)))
                    done++
                }
            } catch (error: Unreachable) {
                throw error
            } catch (error: NotAuthenticated) {
                throw error
            } catch (error: Exception) {
                android.util.Log.w("HushOSShares", "sealing the shares of $nodeId again failed: ${error.javaClass.name}")
                failed++
            } finally {
                progress(index + 1, todo.size)
            }
        }
        if (failed > 0) skipped.add("Some shares couldn’t be sealed again under your current keys. They’re tried again the next time you open HushOS.")
        else { seals.pending = null; seals.lastPass = System.currentTimeMillis() }
        return RotationResult(done, skipped.toList())
    }

    /* Whether the re-seal pass should run now: a key replacement is waiting to finish, or the last full pass is a day old. */
    fun resealDue(now: Long = System.currentTimeMillis()): Boolean {
        val seals = ShareSeals.of(context)
        return seals.pending != null || now - seals.lastPass >= ShareSeals.PASS_INTERVAL_MS
    }

    /*
     * Rotates the subtree under `item` after a revoke; returns how many nodes were re-sealed and who was left out, and
     * why. Recorded first and cleared once it finishes, so one that stops (no trust set, no network) is tried again at
     * the next Drive open rather than left half done.
     */
    fun rotate(item: Opened, progress: (Int) -> Unit = {}): RotationResult {
        val pending = PendingRotations.of(context)
        pending.add(item.node.workspaceId, item.id)
        val result = rotateSubtree(item, progress)
        pending.remove(item.node.workspaceId, item.id)
        return result
    }

    /* Rotations that stopped before they finished, tried again; one whose item is gone is forgotten. Returns how many finished. */
    fun finishRotations(): Int {
        val pending = PendingRotations.of(context)
        var finished = 0
        for ((ws, nodeId) in pending.all()) {
            if (ws != workspaceId) { pending.remove(ws, nodeId); continue }
            val item = try { resolve(nodeId) } catch (error: NotFound) { pending.remove(ws, nodeId); continue }
            rotate(item)
            finished++
        }
        return finished
    }

    internal fun workspaceKeyBytes(): ByteArray? = workspaceKey

    /*
     * A copy into another workspace (a shared folder, or "Save a copy" of
     * something shared here): the server keeps objects per workspace, so the
     * file is fetched and uploaded again, thumbnail and all. Folders go node by
     * node. Each record is signed as its source checks here, now (Prior): a
     * verified original, in this drive or a share from a checked contact, gets
     * the ordinary statement; one saved from a link stays saved; anything else
     * is re-sealed. Without the trust set nothing is copied.
     */
    fun copyAcross(id: String, parentId: String, name: String? = null, trust: Trust? = null, progress: (Float) -> Unit = {}): Opened {
        val source = resolve(id)
        val checked = trust ?: trustForWrite()
        val prior = Prior.of(source.node, checked)
        if (source.isFolder) {
            val made = createFolder(parentId, name ?: source.name, prior)
            for (child in listChildren(source.id)) copyAcross(child.id, made.id, null, checked, progress)
            return made
        }
        val directory = File(context.cacheDir, "copy-" + UUID.randomUUID())
        try {
            val file = File(directory, source.name)
            download(source.id, file) { progress(it / 2f) }
            val thumb = runCatching { thumbnail(source.id) }.getOrNull()
            return upload(file, name ?: source.name, source.metadata.mime, parentId, null, thumb, prior) { progress(0.5f + it / 2f) }
        } finally {
            directory.deleteRecursively()
        }
    }

    /* Opens a node of this workspace by listing the folder it sits in, which opens the whole chain above. */
    private fun openAnywhere(node: NodeView): Opened? {
        nodes.row(node.workspaceId, node.id)?.let { return it }
        runCatching { listChildren(node.parentId ?: rootId) }
        return nodes.row(node.workspaceId, node.id) ?: runCatching { open(node) }.getOrNull()
    }

    /* Everything this account shared out: to people, and by link. */
    fun sharedByMe(): List<SharedByMe> {
        val (shares, links) = api.sharedByMe()
        return shares.map { (share, node) -> SharedByMe("share-" + share.id, openAnywhere(node), node, share, null) } +
            links.map { (link, node) -> SharedByMe("link-" + link.id, openAnywhere(node), node, null, link) }
    }

    /* Every file in a folder and its subfolders, not counting what is in the Trash. */
    fun filesUnder(folderId: String): List<Opened> {
        val out = ArrayList<Opened>()
        val pending = ArrayDeque(listOf(folderId))
        val seen = HashSet<String>()
        while (pending.isNotEmpty()) {
            val id = pending.removeFirst()
            if (!seen.add(id)) continue
            for (child in listChildren(id)) {
                if (child.node.trashedAt != null) continue
                if (child.isFolder) pending.add(child.id) else if (child.node.currentVersion != null) out.add(child)
            }
        }
        return out
    }

    /*
     * Opens a kept folder for its job, which runs without the app: one of this drive's
     * through the tree; one kept out of a share through that share, walking down from its
     * root. Null when the share is no longer received (its copies are then removed).
     */
    fun openKeptFolder(id: String, shareRoot: String?): Opened? {
        if (shareRoot == null) return resolve(id)
        val mount = mountShares().firstOrNull { it.share.node.id == shareRoot } ?: return null
        nodes.row(mount.share.workspaceId, id)?.let { return it }
        val pending = ArrayDeque(listOf(shareRoot))
        var steps = 0
        while (pending.isNotEmpty() && steps++ < 2_000) {
            for (child in listChildren(pending.removeFirst())) {
                if (child.id == id) return child
                if (child.isFolder) pending.add(child.id)
            }
        }
        throw NotFound("This folder is no longer in the share.")
    }

    /*
     * Keeps a folder: every file in it and its subfolders comes down (what is already here
     * stays), and a file no longer in it (moved out, trashed, deleted) leaves the phone. A
     * file that fails on its own (not the network) is recorded with a wait before its next
     * try (KeepRules) and the rest of the folder is kept. Progress is by bytes, with how
     * many files are done of how many. A folder gone from the drive takes its files with it.
     */
    fun keepFolder(folder: Opened, shareRoot: String? = null, progress: (fraction: Float, done: Int, total: Int) -> Unit = { _, _, _ -> }) {
        if (folder.node.trashedAt != null) { Offline.forgetFolder(context, folder.id); return }
        Offline.rememberFolder(context, folder, shareRoot)
        val files = filesUnder(folder.id)
        val bytes = files.sumOf { it.size ?: 0L }.coerceAtLeast(1L).toDouble()
        var doneBytes = 0L
        var doneFiles = 0
        val failures = Offline.failures(context).associateBy { it.fileId }
        val now = System.currentTimeMillis()
        progress(0f, 0, files.size)
        for (file in files) {
            val size = file.size ?: 0L
            val failure = failures[file.id]
            // A file still waiting after a failure is left for later; it counts as done for the bar.
            if (KeepRules.due(failure, now)) try {
                keepDownloaded(file, via = folder.id) { f -> progress(((doneBytes + f * size) / bytes).toFloat().coerceIn(0f, 1f), doneFiles, files.size) }
                if (failure != null) Offline.clearFailure(context, file.id)
            } catch (error: Exception) {
                if (KeepRules.failsTheJob(error)) throw error
                // An exception's message can carry a file name or path: only its type is logged.
                android.util.Log.w("HushOSOffline", "keeping ${file.id} in ${folder.id} failed: ${error.javaClass.name}")
                Offline.recordFailure(context, KeepRules.failed(failure, file.id, folder.id, file.name, error.message ?: "It didn’t download.", System.currentTimeMillis()))
            }
            doneBytes += size
            doneFiles++
            progress((doneBytes / bytes).toFloat().coerceIn(0f, 1f), doneFiles, files.size)
        }
        val ids = files.map { it.id }.toSet()
        for (entry in Offline.entries(context).filter { it.via == folder.id && it.id !in ids }) Offline.forget(context, entry.id)
        for (gone in Offline.failures(context).filter { it.folderId == folder.id && it.fileId !in ids }) Offline.clearFailure(context, gone.fileId)
    }

    /*
     * Whether a kept folder differs from what is on the phone: a file missing or out of date
     * (unless it failed and is still waiting), one that left it, or the folder gone. A shared
     * folder this session hasn't opened is looked at through its share.
     */
    fun keptFolderStale(id: String, shareRoot: String? = null): Boolean {
        val folder = item(id) ?: if (shareRoot != null) runCatching { openKeptFolder(id, shareRoot) }.getOrElse { return false } ?: return true else return true
        if (folder.node.trashedAt != null) return true
        val files = runCatching { filesUnder(id) }.getOrElse { return false }
        val ids = files.map { it.id }.toSet()
        val failures = Offline.failures(context).associateBy { it.fileId }
        val now = System.currentTimeMillis()
        return files.any { (!Offline.hasVersion(context, it) || Offline.keptWith(context, it.id)?.id != id) && KeepRules.due(failures[it.id], now) } ||
            Offline.entries(context).any { it.via == id && it.id !in ids }
    }

    /* Keeps a file: downloads its current version into the offline store and records it (with the kept folder it came with, if any). */
    fun keepDownloaded(item: Opened, via: String? = null, progress: (Float) -> Unit = {}) {
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
        // The phone may have been wiped while this came down (signed out, or removed from the account):
        // a copy finished after that is not this phone's to keep any more, so it goes at once.
        if (!stillThisAccount()) {
            File(Offline.root(context), item.id).deleteRecursively()
            throw NotAuthenticated()
        }
        // Older versions of the same file go; only the current one is kept.
        destination.parentFile?.parentFile?.listFiles()?.filter { it.name != item.node.currentVersion?.id }?.forEach { it.deleteRecursively() }
        Offline.remember(context, item, via)
    }

    /* Whether this phone still holds this vault's account: a session for it, and its data recorded as its. */
    private fun stillThisAccount(): Boolean =
        Shared.session(context)?.token == api.session.token &&
            AccountStore.of(context).owner()?.equals(api.session.userId, ignoreCase = true) == true

    /* Brings the named kept files up to their current version (replaced elsewhere: fetched again; trashed: forgotten); returns the ids that failed. */
    /*
     * Brings kept copies up to the current version; returns the ones that could not be, with why.
     * A file gone from this account's drive loses its copy: trashed, or purged and so missing from
     * a catalogue the server sent this session (its tombstone went by once, then nothing names it).
     * A file kept out of a share this session has not opened is left alone until it is.
     */
    fun refreshOffline(ids: Collection<String>, progress: (String, Float) -> Unit = { _, _ -> }): Map<String, Exception> {
        val failed = HashMap<String, Exception>()
        val own = workspaceId
        for (entry in Offline.entries(context).filter { it.id in ids }) {
            // Entries from before the workspace was recorded count as this drive's: kept shares were rare, and a copy
            // wrongly dropped comes down again, while one of a purged file would stay readable here for good.
            val mine = (entry.workspaceId ?: own) == own
            // Only this drive's answers are proof: a share's folder asked for under this account's workspace is a 404 too.
            val item = nodes.row(entry.workspaceId ?: own, entry.id) ?: if (!mine) null else try {
                resolve(entry.id)
            } catch (error: NotFound) {
                Offline.forget(context, entry.id)
                continue
            } catch (error: Exception) {
                null
            }
            if (item == null) {
                if (mine && cataloguePulled) Offline.forget(context, entry.id)
                continue
            }
            Offline.recordWorkspace(context, item)
            if (item.isFolder || item.node.trashedAt != null) { Offline.forget(context, entry.id); continue }
            if (Offline.localCopy(context, item) != null) continue
            try {
                keepDownloaded(item) { progress(entry.id, it) }
            } catch (error: Exception) {
                android.util.Log.w("HushOSOffline", "refreshing the kept copy of ${entry.id} failed: ${error.javaClass.name}")
                failed[entry.id] = error
            }
        }
        return failed
    }

    /* The 24 words again, for someone who holds the account key and wants to check their copy. */
    fun recoveryPhrase(): String = recoveryPhrase(api.session.userId, unlockAccount(), Auth.recoveryKey(context))

    /* The workspace a node lives in: a share's subtree belongs to the granter's. */
    private fun workspaceOf(nodeId: String): String = nodes.find(nodeId)?.node?.workspaceId ?: workspaceId

    /*
     * A share as received, with its root opened under the key the granter sealed to this identity; `trust` when
     * the granter's key kept it shut, `explained` when `error` is a sentence for people (a refused share, a later format).
     */
    data class ShareMount(val share: ShareView, val root: Opened?, val error: String?, val trust: GranterTrust? = null, val explained: Boolean = false)

    fun mountShares(): List<ShareMount> {
        val shares = api.sharedWithMe()
        if (shares.isEmpty()) return emptyList()
        val own = workspaceId
        val identities = identities()
        // The pins as they are: a granter's newer keys are followed only when the person checks them again.
        val pins = loadSettings().contacts
        return shares.map { share ->
            runCatching {
                // Before any key is opened: a share into this account's own drive, or for a node of another workspace, is refused.
                checkShare(share, own)
                checkSuite(share.node.envelopeSuite)
                val name = share.granterName.ifEmpty { share.granterEmail }
                val granter = granterKey(share.granterId, name, share.granter, pins)
                val key = openShare(base64urlDecode(share.shareEnvelope), granter, name, identities,
                    ShareContext(share.workspaceId, share.node.id, share.keyEpoch, api.session.userId, share.granterId))
                val metadata = metadataOpen(MetadataContext(share.node.workspaceId, share.node.id, share.node.metadataVersion), key, base64urlDecode(share.node.metadataEnvelope))
                // Kept under the granter's workspace only (NodeCache.adoptShare). The root's parent is the granter's and
                // opens nothing here: it stays out of the parents index, which a share naming one of this drive's ids would rewrite.
                ShareMount(share, nodes.adoptShare(share, own, openedRow(share.node, metadata, key), key), null)
            }.getOrElse { ShareMount(share, null, it.message ?: "This share could not be opened.", it as? GranterTrust, explained = it is Refused) }
        }
    }
    fun item(id: String): Opened? = nodes.find(id)

    /* A folder's name for "Was in …": the top folder is Files, as the tab calls it. */
    fun folderName(id: String?): String? {
        val folder = nodes.find(id ?: return null) ?: return null
        return if (folder.node.parentId == null) "Files" else folder.name
    }

    /* The key a node is wrapped under: its parent's in the same workspace, or this account's workspace key for its own root only. */
    private fun parentKeyFor(node: NodeView): ByteArray {
        val parentId = node.parentId ?: node.workspaceId
        if (parentId == node.workspaceId) {
            if (node.workspaceId != workspace?.workspaceId) throw ApiError(500, "This folder isn’t in your drive.")
            return workspaceKey ?: throw ApiError(500, "Workspace not opened")
        }
        return nodes.key(node.workspaceId, parentId) ?: throw ApiError(500, "Open the containing folder first.")
    }

    @Synchronized
    fun open(node: NodeView): Opened {
        checkSuite(node.envelopeSuite)
        nodes.row(node.workspaceId, node.id)?.let { return it }
        val ctx = NodeKeyContext(node.workspaceId, node.id, node.parentId ?: node.workspaceId, node.parentKeyEpoch, node.keyEpoch)
        val key = nodeOpen(ctx, parentKeyFor(node), base64urlDecode(node.keyEnvelope))
        val metadata = metadataOpen(MetadataContext(node.workspaceId, node.id, node.metadataVersion), key, base64urlDecode(node.metadataEnvelope))
        val result = openedRow(node, metadata, key)
        nodes.put(result, key)
        node.parentId?.let { parents[node.id] = it }
        return result
    }

    /* A node whose key this device made or already held (a write), kept under its own workspace. */
    private fun adopt(node: NodeView, key: ByteArray, metadata: NodeMetadata): Opened {
        checkSuite(node.envelopeSuite)
        val result = openedRow(node, metadata, key)
        nodes.put(result, key)
        node.parentId?.let { rememberParent(node.id, it) }
        return result
    }

    /* What a write answered with, kept only when it is the node written, in the workspace written to. */
    private fun adoptWritten(node: NodeView, key: ByteArray, metadata: NodeMetadata, workspaceId: String, nodeId: String): Opened {
        checkWritten(node, workspaceId, nodeId)
        return adopt(node, key, metadata)
    }

    fun forget(workspaceId: String, id: String) {
        nodes.forget(workspaceId, id)
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
            // Rows are opened only in the workspace asked about; one claiming another is not this folder's.
            if (page.folder.workspaceId != ws || page.folder.id != folderId) throw ApiError(502, "HushOS answered with a different folder.")
            // Above a share's root the keys are the granter's; those ancestors stay closed.
            page.ancestors.filter { it.workspaceId == ws }.forEach { runCatching { open(it) } }
            open(page.folder)
            for (child in page.children) {
                if (child.workspaceId != ws) continue
                // A row in a later format stays out of the list; anything else wrong with one fails the folder, as before.
                val row = try { open(child) } catch (error: NewerFormat) { continue }
                children.add(row)
                parents[child.id] = folderId
            }
            after = page.nextCursor
        } while (after != null)
        saveIndex()
        return children.sortedWith(compareBy<Opened> { !it.isFolder }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    fun resolve(id: String): Opened {
        nodes.find(id)?.let { return it }
        if (id == rootId) listChildren(id) else parents[id]?.let { listChildren(it) }
            ?: throw ApiError(500, "This item has not been seen yet; open its folder first.")
        return nodes.find(id) ?: throw NotFound("This item no longer exists.")
    }

    fun openVersion(item: Opened, version: VersionListView? = null): OpenedVersion {
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
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

    /*
     * Downloads and decrypts a file's version into `destination`, chunk by chunk, resuming a `.part` an earlier try left.
     * Every chunk is fetched, the padding of a suite 3 object included, so the store never learns where the file ends;
     * the core returns only the file's own bytes.
     */
    fun download(id: String, destination: File, version: VersionListView? = null, progress: (Float) -> Unit = {}) {
        val item = resolve(id)
        val v = openVersion(item, version)
        var url = api.versionUrl(v.versionId, item.node.workspaceId)
        Resumable.download(destination, v.layout.chunkCount, v.layout.chunkBytes.toLong(),
            online = { Resumable.online(context) }, progress = progress, fileSize = v.content.plaintextSize.toLong(),
            onExpired = { url = api.versionUrl(v.versionId, item.node.workspaceId) },
        ) { index -> chunkDecrypt(v.content, index, api.range(url, chunkRange(v.content.suite, v.content.plaintextSize, v.content.thumbnailBytes, index))) }
    }

    fun thumbnail(id: String): ByteArray? {
        val item = resolve(id)
        if (!item.hasThumbnail) return null
        val v = openVersion(item)
        if (v.content.thumbnailBytes == 0u) return null
        val ciphertext = mirror.thumbnail(v.versionId) ?: run {
            val url = api.thumbnailUrl(v.versionId, item.node.workspaceId) ?: return null
            // The range is a fixed tail window (so the store never learns the trailer's length); keep only the trailer at its end.
            val window = api.range(url, thumbnailRange(v.content.suite, v.content.plaintextSize, v.content.thumbnailBytes))
            window.copyOfRange(maxOf(0, window.size - v.content.thumbnailBytes.toInt() - 16), window.size).also { mirror.putThumbnail(v.versionId, it) }
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
                forget(entry.node.workspaceId, entry.node.id)
                runCatching { open(entry.node) }.onSuccess { result.add(TrashItem(it, entry.parentTrashed, folderName(entry.node.parentId))) }
            }
            after = page.nextCursor
        } while (after != null)
        return result
    }

    /* The most recently changed files and folders, from the tail of the change feed. */
    fun recents(limit: Int = 60): List<Opened> {
        catalogueRecents(limit)?.let { return it }
        val view = loadWorkspace()
        val feed = api.changes(view.workspaceId, maxOf(0, view.changeSeq - 400), 400)
        val latest = LinkedHashMap<String, NodeView>()
        for (change in feed.changes) {
            if (change.kind != "node") continue
            val node = change.node ?: continue
            if (node.parentId == null || node.trashedAt != null || (!node.isFolder && node.currentVersion == null)) { latest.remove(node.id); continue }
            latest[node.id] = node
        }
        val items = ArrayList<Opened>()
        for (node in latest.values) {
            node.parentId?.let { rememberParent(node.id, it) }
            forget(node.workspaceId, node.id)
            runCatching { resolve(node.id) }.onSuccess { items.add(it) }
        }
        return items.sortedWith(byRecent).take(limit)
    }

    fun versions(id: String): List<VersionListView> = api.versions(id, resolve(id).node.workspaceId)

    // Writes

    /* `copy`: set when the name comes from a record that existed before (a copy, a save from a link); see Prior. */
    fun createFolder(parentId: String, name: String, copy: Prior? = null): Opened {
        // Shared folders belong to the granter's workspace; an editor writes there, and the id is minted there.
        val parent = resolve(parentId)
        val ws = parent.node.workspaceId
        val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        val epoch = api.allocateEpoch(ws)
        val made = IdField.NODE.mint(ws)
        val id = made.id
        val key = randomBytes(32u)
        val wrapped = nodeWrap(NodeKeyContext(ws, id, parent.id, parent.node.keyEpoch, epoch), parentKey, key)
        val metadata = NodeMetadata(checkName(name), null, null, null)
        val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, metadata)
        val signature = if (copy != null) signCopiedMetadata(ws, id, NodeKind.FOLDER, sealed, copy) else signMetadata(ws, id, NodeKind.FOLDER, 1uL, sealed)
        val node = api.createFolder(ws, JSONObject().putId(made).put("parentId", parent.id).put("keyEpoch", epoch.toLong())
            .put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEnvelope", base64urlEncode(wrapped)).put("metadataEnvelope", base64urlEncode(sealed))
            .put("metadataSignature", signature))
        return adoptWritten(node, key, metadata, ws, id)
    }

    fun rename(id: String, name: String): Opened {
        val item = resolve(id)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val metadata = item.metadata.copy(name = name)
        val next = item.node.metadataVersion + 1uL
        // The type, size and date are carried over into the re-signed record: signed as it checked, never vouched for blind.
        val prior = replacedNamePrior(item)
        val sealed = metadataSeal(MetadataContext(item.node.workspaceId, id, next), key, metadata)
        val node = api.rename(id, item.node.workspaceId, item.node.metadataVersion, item.node.keyEpoch, base64urlEncode(sealed),
            signMetadata(item.node.workspaceId, id, if (item.isFolder) NodeKind.FOLDER else NodeKind.FILE, next, sealed, prior))
        return adoptWritten(node, key, metadata, item.node.workspaceId, id)
    }

    /* A node's key wrapped under a new parent's; both in one workspace, or the envelope would name the wrong one. */
    private fun rewrap(item: Opened, parent: Opened): String {
        if (parent.node.workspaceId != item.node.workspaceId) throw ApiError(400, "Move it within one drive.")
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        return base64urlEncode(nodeWrap(NodeKeyContext(item.node.workspaceId, item.id, parent.id, parent.node.keyEpoch, item.node.keyEpoch), parentKey, key))
    }

    fun move(id: String, parentId: String): Opened {
        val item = resolve(id)
        val parent = resolve(parentId)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val node = api.move(id, item.node.workspaceId, parent.id, parent.node.keyEpoch, rewrap(item, parent))
        return adoptWritten(node, key, item.metadata, item.node.workspaceId, id)
    }

    /*
     * A copy under `parentId`: the server keeps the object; the envelopes are resealed here under a fresh node key.
     * Folders go node by node. Each record is checked first, as a reading would: the copy is signed with the ordinary
     * statement where its source verified, the saved one where it was saved from a link, re-sealed otherwise. Without
     * a trust set nothing is copied.
     */
    fun copy(id: String, parentId: String, name: String? = null, trust: Trust? = null): Opened {
        val source = resolve(id)
        val parent = resolve(parentId)
        val ws = parent.node.workspaceId
        val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        val newName = checkName(name ?: source.name)
        val checked = trust ?: trustForWrite()
        val prior = Prior.of(source.node, checked)
        if (source.isFolder) {
            val made = createFolder(parent.id, newName, prior)
            for (child in listChildren(source.id)) copy(child.id, made.id, null, checked)
            return made
        }
        val version = source.node.currentVersion ?: throw NotFound("This file has no content yet.")
        val opened = openVersion(source)
        val epoch = api.allocateEpoch(ws)
        val madeNode = IdField.NODE.mint(ws)
        val madeVersion = IdField.VERSION.mint(ws)
        val newId = madeNode.id
        val versionId = madeVersion.id
        val key = randomBytes(32u)
        val keyEnvelope = nodeWrap(NodeKeyContext(ws, newId, parent.id, parent.node.keyEpoch, epoch), parentKey, key)
        val metadata = source.metadata.copy(name = newName)
        val metadataEnvelope = metadataSeal(MetadataContext(ws, newId, 1uL), key, metadata)
        val contentKeyEnvelope = versionReseal(
            VersionContext(ws, newId, versionId, version.objectId), version.contentSuite, key,
            ContentKey(opened.content.key, opened.content.plaintextSize, opened.content.thumbnailBytes),
        )
        // Signed over the copy's node and version, the source version's object and its content suite.
        val node = api.copy(source.id, ws, JSONObject().put("sourceVersionId", version.id)
            .put("node", JSONObject().putId(madeNode).put("parentId", parent.id).put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEpoch", epoch.toLong())
                .put("keyEnvelope", base64urlEncode(keyEnvelope)).put("metadataEnvelope", base64urlEncode(metadataEnvelope))
                .put("metadataSignature", signCopiedMetadata(ws, newId, NodeKind.FILE, metadataEnvelope, prior)))
            .putId(madeVersion).put("contentKeyEnvelope", base64urlEncode(contentKeyEnvelope))
            .put("versionSignature", signCopiedVersion(ws, newId, versionId, version.objectId, version.contentSuite, contentKeyEnvelope, prior)))
        return adoptWritten(node, key, metadata, ws, newId)
    }

    fun trash(id: String) {
        val item = resolve(id)
        api.trash(id, item.node.workspaceId)
        forget(item.node.workspaceId, id)
    }

    /*
     * Move to Trash for many, one outcome per id in order, `moved` told of each id as the server
     * confirms it: the one place a batch reaches the server. One request each, one after another,
     * until the server takes a batch in one request.
     */
    fun trashMany(ids: List<String>, moved: (String) -> Unit = {}): List<Result<Unit>> = oneAfterAnother(ids) { trash(it); moved(it) }

    fun restore(entry: TrashItem): Opened {
        val item = nodes.row(entry.item.node.workspaceId, entry.item.id) ?: open(entry.item.node)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val toRoot = if (entry.parentTrashed) resolve(rootId).let { root -> root.node.keyEpoch to rewrap(item, root) } else null
        val node = api.restore(item.id, item.node.workspaceId, toRoot)
        return adoptWritten(node, key, item.metadata, item.node.workspaceId, item.id)
    }

    fun purge(id: String) {
        val ws = workspaceId
        api.purge(id, ws)
        forget(ws, id)
    }

    fun emptyTrash(): EmptyTrashResult = api.emptyTrash(workspaceId)

    fun restoreVersion(version: VersionListView, id: String): Opened {
        val item = resolve(id)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        return adoptWritten(api.restoreVersion(version.id, item.node.workspaceId), key, item.metadata, item.node.workspaceId, id)
    }

    /* A JPEG for the lists, the grid and the picker, 512px on the long edge as the web makes one at upload; null when not an image or too big. */
    fun makeThumbnail(file: File, mime: String?): ByteArray? {
        if (mime?.startsWith("image/") != true) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
        val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        // Size first, then quality, as the web does: a sharp picture a little smaller beats a large smeared one.
        for (edge in intArrayOf(512, 384, 256, 192, 128)) {
            val scale = minOf(1f, edge.toFloat() / maxOf(bitmap.width, bitmap.height))
            val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true) else bitmap
            // JPEG has no alpha: transparent images sit on the sheet colour, not on black.
            val small = Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888).also { flat ->
                val canvas = android.graphics.Canvas(flat)
                canvas.drawColor(0xFFFCFBF7.toInt())
                canvas.drawBitmap(scaled, 0f, 0f, null)
            }
            for (quality in intArrayOf(82, 70, 58)) {
                val out = ByteArrayOutputStream()
                small.compress(Bitmap.CompressFormat.JPEG, quality, out)
                if (out.size() <= 65_536) return out.toByteArray()
            }
        }
        return null
    }

    /*
     * How metadata re-signed over a record that existed is signed (a new version keeps its name; a rename keeps its
     * type, size and date): as that record checks. Verified stays ordinary, saved from a link stays saved, anything
     * else is re-sealed. Without the trust set it throws (an upload waits and is tried again) rather than vouching for
     * what nobody checked.
     */
    private fun replacedNamePrior(replacing: Opened): Integrity {
        val verdict = metadataVerdict(replacing.node, trustForWrite())
        if (verdict == Integrity.UNCHECKED) throw TrustUnavailable()
        return verdict
    }

    /*
     * A file's bytes as a new node under `parentId`, or a new version of `replacing`; a thumbnail rides after the last
     * chunk. `copy`: set when the bytes and name are a copy of a record that existed before (a copy across drives, a
     * save from a link), which decides how the new node is signed; see Prior. Every id is minted in the workspace
     * written to, fresh for each call: an attempt that stops starts over with new ids and seeds.
     */
    fun upload(file: File, name: String, mime: String?, parentId: String, replacing: Opened?, thumbnail: ByteArray? = null, copy: Prior? = null, progress: (Float) -> Unit = {}): Opened {
        // The workspace written to: the replaced file's, or the folder's (a share's subtree is the granter's).
        val ws = replacing?.node?.workspaceId ?: resolve(parentId).node.workspaceId
        // A new version carries the old name over into metadata signed again: checked before any byte goes up, so an
        // unverified name is re-sealed rather than vouched for, and nothing is uploaded when the check can't run.
        val keptName = replacing?.let { replacedNamePrior(it) }
        val size = file.length().toULong()
        val modified = Instant.ofEpochMilli(file.lastModified()).toString()
        val madeVersion = IdField.VERSION.mint(ws)
        val madeObject = IdField.OBJECT.mint(ws)
        val versionId = madeVersion.id
        val objectId = madeObject.id
        val contentKey = randomBytes(32u)
        val contentNonce = randomBytes(16u)
        val thumbnailBytes = (thumbnail?.size ?: 0).toUInt()
        val nodeId: String
        val nodeKey: ByteArray
        val nodeInput: JSONObject
        val metadata: NodeMetadata
        if (replacing != null) {
            nodeId = replacing.id
            nodeKey = nodes.key(replacing) ?: throw ApiError(500, "Node not opened")
            nodeInput = JSONObject().put("existing", true).put("id", nodeId).put("keyEpoch", replacing.node.keyEpoch.toLong())
                .put("expectedVersionId", replacing.node.currentVersion?.id ?: JSONObject.NULL)
            metadata = replacing.metadata
        } else {
            val parent = resolve(parentId)
            if (parent.node.workspaceId != ws) throw ApiError(400, "Upload it within one drive.")
            val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
            val epoch = api.allocateEpoch(ws)
            val madeNode = IdField.NODE.mint(ws)
            nodeId = madeNode.id
            nodeKey = randomBytes(32u)
            val wrapped = nodeWrap(NodeKeyContext(ws, nodeId, parent.id, parent.node.keyEpoch, epoch), parentKey, nodeKey)
            metadata = NodeMetadata(checkName(name), mime, size, modified)
            val sealed = metadataSeal(MetadataContext(ws, nodeId, 1uL), nodeKey, metadata)
            val signature = if (copy != null) signCopiedMetadata(ws, nodeId, NodeKind.FILE, sealed, copy) else signMetadata(ws, nodeId, NodeKind.FILE, 1uL, sealed)
            nodeInput = JSONObject().put("existing", false).putId(madeNode).put("parentId", parent.id).put("keyEpoch", epoch.toLong())
                .put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEnvelope", base64urlEncode(wrapped)).put("metadataEnvelope", base64urlEncode(sealed))
                .put("metadataSignature", signature)
        }
        // Suite 3: the object is padded to a Padmé bucket, so its size says little about the file's; the core pads each chunk.
        val suite = contentSuite()
        val version = versionSeal(VersionContext(ws, nodeId, versionId, objectId), nodeKey, contentKey, size, thumbnailBytes)
        val content = Content(ws, objectId, suite, contentKey, contentNonce, size, thumbnailBytes)
        val layout = version.layout
        val versionSignature = if (copy != null) signCopiedVersion(ws, nodeId, versionId, objectId, suite, version.envelope, copy)
            else signVersion(ws, nodeId, versionId, objectId, suite, version.envelope)
        val begun = api.beginUpload(ws, JSONObject().put("node", nodeInput).putId(madeVersion).putId(madeObject)
            .put("contentKeyEnvelope", base64urlEncode(version.envelope)).put("contentNonce", base64urlEncode(contentNonce))
            .put("versionSignature", versionSignature)
            .put("contentSuite", suite.toInt()).put("chunkCount", layout.chunkCount.toLong()).put("ciphertextSize", layout.ciphertextSize.toString()))
        val urls = HashMap<Int, String>()
        for (part in begun.parts) urls[part.partNumber] = part.url
        val etags = JSONArray()
        try {
            RandomAccessFile(file, "r").use { raf ->
                for (index in 0uL until layout.chunkCount) {
                    val partNumber = index.toInt() + 1
                    if (!urls.containsKey(partNumber)) for (part in api.partUrls(begun.uploadId, ws, partNumber)) urls[part.partNumber] = part.url
                    // The file's own bytes for this chunk (none in the padding past its end); the core adds the zeros.
                    val length = chunkLength(size, index).toInt()
                    val plaintext = ByteArray(length)
                    if (length > 0) {
                        raf.seek((index * layout.chunkBytes).toLong())
                        raf.readFully(plaintext)
                    }
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
                    progress(Resumable.fraction(index + 1uL, layout.chunkCount, layout.chunkBytes.toLong(), size.toLong()))
                }
            }
        } catch (error: Exception) {
            api.abortUpload(begun.uploadId, ws)
            throw error
        }
        // Refused: aborted, so its reserved room is released now. Unknown: asked again, never aborted blind (UploadFinish).
        var node = UploadFinish.complete({ api.completeUpload(begun.uploadId, ws, etags) }, { api.abortUpload(begun.uploadId, ws) })
            ?: throw ApiError(500, "Upload completed without a node")
        checkWritten(node, ws, nodeId)
        var final = metadata
        if (replacing != null) {
            // A new version has a new size and date; the sealed metadata says so too, as the lists read it.
            final = metadata.copy(mime = mime ?: metadata.mime, size = size, modified = modified)
            val next = node.metadataVersion + 1uL
            val sealed = metadataSeal(MetadataContext(ws, nodeId, next), nodeKey, final)
            node = api.rename(nodeId, ws, node.metadataVersion, node.keyEpoch, base64urlEncode(sealed), signMetadata(ws, nodeId, NodeKind.FILE, next, sealed, keptName))
        }
        return adoptWritten(node, nodeKey, final, ws, nodeId)
    }
}
