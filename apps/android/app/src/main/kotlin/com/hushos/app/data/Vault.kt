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
    /* In Recent: when it sorts there (`collapseRecents`), which a folder takes from the newest of what it stands in for. */
    val recentMillis: Long? = null,
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
 * Recent shows a folder once, not again for what it holds (the web's `collapseRecent`), as a window
 * over what changed lately: items are taken newest first by their own time, and one with a kept
 * folder above it (at any depth) is folded into that folder instead of kept. A folder kept later
 * takes in what was kept below it, so the topmost recent folder stands in for everything under it.
 * The walk stops once `limit` rows are kept, so a folder older than that window hides nothing: a
 * file changed today inside it shows on its own. `parentOf` walks up through folders not among
 * `items`; one it doesn't know ends the walk. Each row carries the newest change it stands for as
 * `recentMillis`, which Recent sorts by and shows.
 */
fun collapseRecents(items: List<Opened>, limit: Int, parentOf: (String) -> String? = { null }): List<Opened> {
    val held = items.associateBy { it.id }
    fun parent(id: String): String? = held[id]?.node?.parentId ?: parentOf(id)
    // Kept rows by id, with the newest change each stands for (null: none carried a date).
    val kept = HashMap<String, Long?>()
    // The kept folder above an id, if any: on any line of folders at most one is kept.
    fun keptAbove(id: String): String? {
        val walked = HashSet<String>()
        var current = parent(id)
        while (current != null && walked.add(current)) {
            if (kept.containsKey(current)) return current
            current = parent(current)
        }
        return null
    }
    fun newest(a: Long?, b: Long?) = if (a == null) b else if (b == null) a else maxOf(a, b)
    // Newest first; things changed in the same moment by name, then id, as the web orders them, so the list never reshuffles.
    val collator = java.text.Collator.getInstance()
    for (item in held.values.sortedWith(compareByDescending<Opened> { it.changedMillis ?: 0L }.thenBy(collator) { it.name }.thenBy { it.id })) {
        if (kept.size >= limit) break
        val above = keptAbove(item.id)
        if (above != null) {
            kept[above] = newest(kept[above], item.changedMillis)
            continue
        }
        var at = item.changedMillis
        if (item.isFolder) {
            kept[item.id] = at
            for (id in kept.keys.toList()) if (id != item.id && keptAbove(id) == item.id) at = newest(at, kept.remove(id))
        }
        kept[item.id] = at
    }
    return kept.entries.map { held.getValue(it.key) to it.value }
        .sortedWith(compareByDescending<Pair<Opened, Long?>> { it.second ?: 0L }.thenBy(collator) { it.first.name }.thenBy { it.first.id })
        .map { (item, millis) -> item.copy(recentMillis = millis) }
}

/* What changed lately, two ways: as Home's Recent shows it, and as it is, for search. */
class Recents(items: List<Opened>, limit: Int, keep: (Opened) -> Boolean, parentOf: (String) -> String?) {
    /* Home's rows: what `keep` lets through, a recent folder standing in for what it holds (`collapseRecents`). */
    val rows: List<Opened> = collapseRecents(items.filter(keep), limit, parentOf)
    /* The newest changes of every type with nothing folded in: what search falls back on before the catalogue. */
    val latest: List<Opened> = items.sortedWith(compareByDescending<Opened> { it.changedMillis ?: 0L }.thenBy(java.text.Collator.getInstance()) { it.name }.thenBy { it.id }).take(limit)
}

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
/* A share made, and whether checking whom it is sealed to moved whom this phone trusts (a legacy pin made first-seen, a
 * succession followed, a first guard entry), so what is drawn is judged again. */
data class ShareResult(val share: OwnedShare, val trustChanged: Boolean)

class Vault(internal val context: Context, val api: DriveApi) {
    private var accountKey: ByteArray? = null
    private var workspace: WorkspaceView? = null
    private var workspaceKey: ByteArray? = null
    /* The tree mirror on disk and the catalogue built from it (see Catalogue.kt). */
    internal val mirror = Mirror.shared(context)
    @Volatile internal var catalogueState: CatalogueState = CatalogueState.IDLE
    /* The catalogue holds what the server sent this session, not only what the phone had: a node missing from it is gone. */
    @Volatile internal var cataloguePulled = false
    /* Where this vault's catalogue stands in the feed: its own, since other vaults in this process share the mirror. */
    @Volatile internal var catalogueCursor = 0
    /* The mirror generation that cursor was taken under (Mirror.FeedState): 0, none, until the catalogue is built. */
    @Volatile internal var catalogueGeneration = 0L
    /* What the catalogue held before a rebuild that hasn't succeeded yet (Catalogue.kt, rebuildCatalogue): Files is owed the difference. */
    @Volatile internal var owedFiled: Map<String, Pair<String, Int?>>? = null
    /* One sync or build at a time; the maps below are read from many threads while one of them writes. */
    internal val syncLock = Any()
    internal val catalogueChildren = ConcurrentHashMap<String, MutableSet<String>>()
    /* Node keys and rows by (workspace, node): a share's keys never answer for this account's own nodes (NodeCache). */
    internal val nodes = NodeCache { workspace?.workspaceId }
    /*
     * Nodes a rotation on this device re-keyed whose subtree it hasn't finished, by workspace and node: the epoch the
     * server applied, and the key before it, which children the walk hasn't reached are still wrapped under. Kept from
     * the moment the server applies a batch until that rotation ends, so a retry (or a listing meanwhile) opens what is left.
     */
    internal val rotatedKeys = java.util.concurrent.ConcurrentHashMap<Pair<String, String>, RotatedKey>()
    /* The identity in use and the earlier ones, opened once and kept until forgotten (see OpenedIdentities). */
    private val ownIdentities = OpenedIdentities(
        open = {
            openOwnIdentity(api.session.userId, unlockAccount(), marks(),
                served = { Auth.identity(context, api.session) },
                store = { Auth.upgradeIdentity(context, it, api.session) },
                upgraded = { ShareSeals.of(context).lastPass = 0L },
            )
        },
        // Each opened under the account key, which proves it is this account's own, not one the server added.
        history = { Auth.identityHistory(context, api.session).mapNotNull { runCatching { identityOpen(api.session.userId, unlockAccount(), it) }.getOrNull() }.reversed() },
    )
    /* The settings key, opened under the account key once the server served it (or this device made it). */
    private var settingsKey: ByteArray? = null
    /* The envelope `settingsKey` came out of, as the server keeps it: kept beside the rollback marks. */
    private var settingsKeyEnvelope: com.hushos.core.SettingsKeyEnvelope? = null
    /* Lookups kept for display, people found changed, the trust generation, the tests' hooks (ContactTrust.kt). */
    val memory = TrustMemory()

    /* The area ledger: this session's families, their chains and the family folders' keys (FamilySync, VaultFamilies.kt). */
    internal val areaLedger = com.hushos.core.AreaLedger()
    /*
     * This session's family state, shared with every other vault of the session in this process (FamilySessions): the
     * Files app's and each transfer job's see the same proofs, holds, invalidations and end as this one.
     */
    internal val familyState: FamilySessionState = FamilySessions.of(api.session)
    /* Each family folder route 25 named this session, lowercase, to its family: never opened under a personal key. */
    internal val familyAreas: ConcurrentHashMap<String, String> get() = familyState.areas
    /*
     * The write barrier's hold, apart from familyAreas: the folders an accepted member list names before route 25 proved
     * them (a guard that can't be stored stops writes into them). Never makes a workspace a family folder: a member list
     * naming a share's workspace (or any other) only holds that family's writes while its guard is owed. Every family that
     * named it, so a first roster's word never keeps another family's barrier off it.
     */
    internal val familyHeld: ConcurrentHashMap<String, MutableSet<String>> get() = familyState.held
    /* Every family folder node this session opened, to its workspace: listed there again after its family let go of it (the core then refuses). */
    internal val familyNodes = ConcurrentHashMap<String, String>()
    /*
     * Each family folder's invalidation, lowercase workspace to a count and the family's words: moved by every forget (a
     * removal, a fork, a refusal). A download or a listing begun before it never keeps, writes or shows what it opened.
     */
    internal val familyEpochs: ConcurrentHashMap<String, Pair<Long, String>> get() = familyState.epochs
    /* Held while a forget deletes family copies or the session ends, and while a download makes its folder, writes or keeps its file. */
    internal val familyCopiesLock: Any get() = FamilyCopies.LOCK
    /* Set once this vault's session ended (close, by this vault or another of the session): nothing it downloads is written after. */
    internal val closed: Boolean get() = familyState.closed
    /* Families whose acceptance may hand back a guard not stored yet: nothing is written into them meanwhile (the write barrier). */
    internal val familyGuardOwed: MutableSet<String> get() = familyState.guardOwed
    /* Tests: whether the family guard can be written (a full disk when not), and a stop right after each write, as a crash would. */
    internal var familyGuardWrites: () -> Boolean = { true }
    internal var afterFamilyGuard: (() -> Unit)? = null
    /* Tests: runs right after the ledger opened a family node's key, before it is kept (a forget landing there). */
    internal var afterFamilyOpen: (() -> Unit)? = null
    /* Tests: runs right before a row opened by a share's or this account's keys is kept (a family's proof landing there). */
    internal var beforeKept: ((workspaceId: String) -> Unit)? = null
    /* Tests: runs as a write reaches its final gate, before it is checked (a sync proving the folder meanwhile). */
    internal var beforeWriteGate: ((workspaceId: String) -> Unit)? = null
    /* Ids whose copies a family's proof deleted (VaultFamilies.purgeShareCopies): the screens drop them (drainFamilyPurged). */
    internal val familyPurged: MutableSet<String> get() = familyState.purged
    /* The family guard (FamilyGuard.kt), sealed under the settings key as the contact guard is. */
    internal val familyGuard: FamilyGuardStore
        get() = FamilyGuardStore.of(context, api.session, familyGuardWrites) { kept, create -> marksKey(kept, create, served = null) }
    /*
     * The family sync that last synced through this vault (it registers itself on every sync, iOS's familyJudge): what a
     * family folder's write asks for the form a record is signed again with. Never made here for a write, so a job's or
     * the Files app's vault, which syncs no family, judges nothing and writes nothing into a family folder.
     */
    @Volatile internal var familyJudge: FamilySync? = null
    /* This session's family sync: one per vault, so one per session in this process. */
    val families: FamilySync by lazy { FamilySync(this) }
    /*
     * A transfer job's own family sync (FamilyUploads): it accepts the family into this vault's ledger as the app's does,
     * but never sweeps family copies (the app's are not its to judge). Only a job's vault takes this one.
     */
    internal val jobFamilies: FamilySync by lazy { FamilySync(this, sweeps = false) }

    /*
     * The contact guard (ContactGuard.kt), sealed under the settings key as the rollback marks find theirs: the envelope
     * kept beside the record when it opens under the account key, else this process's, else the server's. None to be
     * had (no account key, nothing served) leaves the guard unreadable, never empty.
     */
    internal val guard: ContactGuard
        get() = memory.guard ?: ContactGuard.of(context, api.session) { kept -> marksKey(kept, create = false, served = null) }
    private val indexFile = File(context.filesDir, "files-parents.json")
    internal val parents: ConcurrentHashMap<String, String> = ConcurrentHashMap<String, String>().also { map ->
        runCatching {
            val json = JSONObject(indexFile.readText())
            for (key in json.keys()) map[key] = json.getString(key)
        }
    }

    init {
        api.onBadSignature = { forgetIdentity() }
        // Every write's last word, right before it is sent, wherever it began (the app, the Files app, a worker).
        api.beforeWrite = { finalWriteGate(it) }
        // A job's process may start without the app's: the folders this account's device records kept as family folders
        // are family folders here too, before any sync of this process proves them again.
        seedFamilyAreas()
    }

    companion object {
        fun fromShared(context: Context): Vault? = Shared.session(context)?.let { Vault(context, DriveApi(it)) }
    }

    private fun saveIndex() {
        val json = JSONObject()
        for ((k, v) in parents) json.put(k, v)
        runCatching { indexFile.writeText(json.toString()) }
    }

    /* Ids no longer this device's to remember where they sit (a family folder forgotten): out of the index on disk too. */
    internal fun forgetParents(ids: Collection<String>) {
        if (ids.isEmpty()) return
        ids.forEach { parents.remove(it) }
        saveIndex()
    }

    internal fun rememberParent(id: String, parent: String) {
        if (parents[id] == parent) return
        parents[id] = parent
        saveIndex()
    }

    internal fun unlockAccount(): ByteArray {
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
                val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, NodeMetadata(ROOT_NAME, null, null, null, emptyMap()))
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
        // Every pin as this phone's guard allows (2.8): read under the guard's turn, acts left pending settled first.
        return Trust.of(api.session.userId, base64urlDecode(all[0].signingPublicKey), all.drop(1).map { base64urlDecode(it.signingPublicKey) }, effectivePins())
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
        refuseFamilyWrite(item.node.workspaceId)
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
        refuseFamilyWrite(item.node.workspaceId)
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
    fun discardVersion(item: Opened, version: VersionListView) {
        refuseFamilyWrite(item.node.workspaceId)
        api.discardVersion(version.id, item.node.workspaceId)
    }

    /* Files a report on an item shared with this account; the session names the reporter. */
    fun report(item: Opened, category: String, reason: String, email: String?): Boolean {
        refuseFamilyWrite(item.node.workspaceId)
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val operators = PublicApi(api.session.origin).operators()
        return api.fileReport(Reports.body(operators, item, nodeKey, category, reason, email, JSONObject().put("share", true)))
    }

    // Contacts and shares to people

    /* The settings key the server holds, opened under the account key; null until some device stored one. */
    private fun openSettingsKey(stored: Auth.StoredSettings): ByteArray? {
        settingsKey?.let { return it }
        val wrapped = stored.key ?: return null
        return settingsKeyOpen(api.session.userId, unlockAccount(), wrapped).also { settingsKey = it; settingsKeyEnvelope = wrapped }
    }

    /*
     * The settings key the rollback marks are sealed under (SettingsMark): the envelope kept beside them when it opens
     * under the account key (it does until a master-key rotation), else the one this vault opened, else the server's
     * (`served` when the caller has just read it). With `create`, an account with none gets one; without, null.
     */
    private fun marksKey(kept: com.hushos.core.SettingsKeyEnvelope?, create: Boolean, served: Auth.StoredSettings?): MarksKey? {
        if (kept != null) runCatching { settingsKeyOpen(api.session.userId, unlockAccount(), kept) }.getOrNull()?.let { return MarksKey(it, kept) }
        val cached = settingsKey
        val cachedEnvelope = settingsKeyEnvelope
        if (cached != null && cachedEnvelope != null) return MarksKey(cached, cachedEnvelope)
        val stored = served ?: Auth.settings(context, api.session)
        stored.key?.let { wrapped -> return MarksKey(openSettingsKey(stored) ?: return null, settingsKeyEnvelope ?: wrapped) }
        if (!create) return null
        val key = settingsKeyForSave()
        return settingsKeyEnvelope?.let { MarksKey(key, it) }
    }

    /* This account's rollback marks, opened under the settings key through this vault. */
    private fun marks(served: Auth.StoredSettings? = null) = SettingsMark.of(context, api.session.token) { kept, create -> marksKey(kept, create, served) }

    /*
     * The settings key for the next save: the stored one, or a new one wrapped under the account key and stored first
     * (once per account; a device that raced reads the one that won and uses that).
     */
    private fun settingsKeyForSave(): ByteArray {
        settingsKey?.let { return it }
        val stored = Auth.settings(context, api.session)
        openSettingsKey(stored)?.let { return it }
        val made = settingsKeyCreate(api.session.userId, unlockAccount())
        try {
            // Under this vault's own session: a key is stored once and for good, so never into another account.
            Auth.putSettingsKey(context, made.envelope, api.session)
        } catch (error: AuthFailure) {
            if (error.status != 409) throw error
            return openSettingsKey(Auth.settings(context, api.session)) ?: throw error
        }
        settingsKey = made.key
        settingsKeyEnvelope = made.envelope
        return made.key
    }

    /*
     * The settings as the server holds them, refused when older than this device has seen (see readServedSettings).
     * Version 2 opens under the settings key. Version 1 (sealed under a key off the identity, which a stolen identity
     * key opened) no longer opens: it reads as no settings at its stored sequence, and the next save goes over it.
     */
    fun loadSettings(): Settings = settingsServed().first

    /* The settings as loadSettings reads them, with what the server served them in (the area ledger opens those itself). */
    internal fun settingsServed(): Pair<Settings, Auth.StoredSettings> {
        val userId = api.session.userId
        val identity = identityKeys()
        val stored = Auth.settings(context, api.session)
        val mark = marks(stored)
        // A mark an earlier app kept per identity carries over first, so the per-account one never starts lower.
        mark.adopt(userId, listOf(identity.encryptionPublicKey))
        return readServedSettings(userId, stored.envelope, stored.sequence, mark) {
            openSettingsKey(stored) ?: throw AuthFailure("Your settings key is missing. Sign in again.")
        } to stored
    }

    /*
     * Compare-and-set: read, change, seal one version up, save over the version read. Another device
     * saving in between is a 409: read again and apply the change again, up to three tries. The JSON
     * is edited in place, so fields this app doesn't know (the web's, a later client's) survive.
     */
    internal fun updateSettings(beforeSend: ((base: ULong) -> Unit)? = null, change: (Settings) -> Unit): Settings {
        val key = settingsKeyForSave()
        var attempt = 0
        while (true) {
            val settings = loadSettings()
            change(settings)
            // Removals count against the room the document has: the oldest go first (docs/optional-verification.md 2.7).
            settings.fit()
            // Each attempt names the sequence it lands over (a contact act's pending record), before it is sent.
            beforeSend?.invoke(settings.version)
            val next = settings.version + 1uL
            memory.generation.incrementAndGet()
            try {
                // Always version 2, under the settings key: a version 1 document is moved over by its first save here.
                // Named over the stored sequence and sealed at one above it, the version the server stores it at.
                Auth.putSettings(context, settings.version, settingsSeal(api.session.userId, key, next, settings.text()), api.session)
                // Always version 2: from here on, no document at all is a rollback.
                marks().recordSettings(api.session.userId, next, sealedV2 = true)
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
    fun currentOwnFingerprint(): String = ownFingerprint(ownIdentities.current(Auth.identity(context, api.session)))

    fun shares(item: Opened): List<OwnedShare> = api.shares(item.id, item.node.workspaceId)

    /*
     * Shares an item with a contact: the served keys must be the ones the pin (verified or first-seen) holds and agree
     * with this phone's guard (`trustGrantee`), then the node key is sealed to them in suite 4 (hybrid, signed with both
     * halves of this account's identity), and the share goes in the ledger once the server took it. A changed account
     * throws AccountChanged: nothing is shared.
     */
    fun share(item: Opened, pin: ContactPin, role: String): ShareResult {
        refuseFamilyWrite(item.node.workspaceId)
        val nodeKey = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val contact = Auth.lookupContact(context, pin.email, api.session)
        if (!contact.userId.equals(pin.userId, ignoreCase = true)) throw ContactProblem.otherAccount()
        // Every guard write and settings save moves the generation: one during the check (a legacy pin made first-seen,
        // a succession followed, a first guard entry) is a change in trust, which the caller refreshes for.
        val generation = memory.generation.get()
        val (publicKey, kem) = trustGrantee(contact, follow = true)
        val trustChanged = memory.generation.get() != generation
        val keys = identityKeys()
        val ctx = ShareContext(item.node.workspaceId, item.id, item.node.keyEpoch, contact.userId, api.session.userId)
        val envelope = shareSeal(ctx, nodeKey, keys, publicKey, kem)
        val share = api.createShare(item.id, JSONObject().put("workspaceId", item.node.workspaceId).put("granteeUserId", contact.userId).put("role", role)
            .put("keyEpoch", item.node.keyEpoch.toLong()).put("shareEnvelope", base64urlEncode(envelope)))
        ShareSeals.of(context).record(mapOf(share.id to ShareSeals.Seal(keys.keyVersion, contact.keyVersion)))
        updateSettings { it.addShare(item.id, contact.userId) }
        return ShareResult(share, trustChanged)
    }

    /* Out of the ledger first (saved before the revoke and the rotation after it), so no rotation seals to them again. */
    fun revokeShare(share: OwnedShare, item: Opened) {
        refuseFamilyWrite(item.node.workspaceId)
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
            succeedOwnIdentity(userId, unlockAccount(), opened, Auth.identity(context, api.session))
        } catch (error: IdentityMoved) {
            forgetIdentity()
            throw error
        }
        Auth.succeedIdentity(context, succession, api.session)
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
        // People whose new keys were accepted or followed: everything shared with them is sealed again, whatever the record says.
        // Read before the settings, so every request this pass may acknowledge is judged against settings at least as new as
        // itself (a Continue queues before its save): one that lands after this read is never consumed by an older view.
        val queued = seals.queued
        val settings = loadSettings()
        val ledger = settings.ledger
        val keys = identityKeys()
        // What is in the Trash, asked once and only when a ledger item can't be found: a trashed item is left out of its
        // folder's listing exactly as a deleted one is, but restored it would still hold the old keys.
        val trashed by lazy { trashedIds() }
        val skipped = LinkedHashSet<String>()
        val served = HashMap<String, Contact?>()
        val sealTo = granteeSealer(settings)
        val failedFor = HashSet<String>()
        val todo = ledger.shares.filterValues { it.isNotEmpty() }
        var done = 0
        var failed = 0
        progress(0, todo.size)
        for ((index, entry) in todo.entries.withIndex()) {
            val (nodeId, people) = entry
            try {
                // Only a node confirmed gone (its folder lists without it, or the server says so) has nothing left to share:
                // its people are done with here. Anything else that stops this node (not found here yet, no network, a key
                // not opened, a trashed item that may come back) keeps them queued, so the next pass seals it.
                val item = try {
                    resolve(nodeId)
                } catch (gone: NotFound) {
                    if (nodeId in trashed) people.forEach { failedFor.add(it.lowercase()) }
                    continue
                }
                if (item.node.workspaceId != workspaceId) continue
                if (item.node.trashedAt != null) { people.forEach { failedFor.add(it.lowercase()) }; continue }
                val nodeKey = nodes.key(item) ?: throw ApiError(500, "A shared item couldn’t be opened to seal it again.")
                val rows = api.shares(item.id, item.node.workspaceId).filter { it.granteeId in people }
                val wire = rows.mapNotNull { share ->
                    // Someone no longer pinned keeps the envelope they have.
                    val pin = settings.pinOf(share.granteeId) ?: return@mapNotNull null
                    val owed = share.granteeId.lowercase() in queued
                    if (!owed && !needsReseal(share.suite, seals.get(share.id), keys.keyVersion, pin.keyVersion)) return@mapNotNull null
                    // The post-quantum key to seal to is only in a lookup; whether it may be sealed to is the guard's (sealTo).
                    val contact = served.getOrPut(share.granteeId) { runCatching { Auth.lookupContact(context, pin.email, api.session) }.getOrNull() }
                    val grantee = contact?.takeIf { it.userId.equals(share.granteeId, ignoreCase = true) }
                    if (grantee == null) { failedFor.add(share.granteeId.lowercase()); return@mapNotNull null }
                    JSONObject().put("id", share.id).put("granteeUserId", share.granteeId).put("grantee", grantee.served.toJson())
                }
                val plan = planReseal(item.id, wire, emptyList(), ledger, sealTo)
                skipped.addAll(plan.skipped)
                val sealedTo = plan.shares.map { it.granteeUserId.lowercase() }.toSet()
                wire.forEach { share -> share.getString("granteeUserId").lowercase().let { if (it !in sealedTo) failedFor.add(it) } }
                for (share in plan.shares) {
                    val ctx = ShareContext(item.node.workspaceId, item.id, item.node.keyEpoch, share.granteeUserId, api.session.userId)
                    api.resealShare(share.id, item.node.workspaceId, item.node.keyEpoch, base64urlEncode(shareSeal(ctx, nodeKey, keys, share.publicKey, share.kemPublicKey)))
                    // Sealed to the pinned keys, which are the ones served at this version.
                    seals.record(mapOf(share.id to ShareSeals.Seal(keys.keyVersion, served[share.granteeUserId]?.keyVersion)))
                    done++
                }
            } catch (error: Unreachable) {
                throw error
            } catch (error: NotAuthenticated) {
                throw error
            } catch (error: Exception) {
                android.util.Log.w("HushOSShares", "sealing the shares of $nodeId again failed: ${error.javaClass.name}")
                people.forEach { failedFor.add(it.lowercase()) }
                failed++
            } finally {
                progress(index + 1, todo.size)
            }
        }
        // Everyone queued whose shares were all sealed again (or who has none left) is let go; the rest stay for the next pass.
        seals.unqueue(queued.filterKeys { it !in failedFor })
        if (failed > 0) skipped.add("Some shares couldn’t be sealed again under your current keys. They’re tried again the next time you open HushOS.")
        else {
            // Only a key replacement this pass sealed for (its identity or an older one): one begun while it ran waits for its own.
            seals.clearPending(upTo = keys.keyVersion)
            seals.lastPass = System.currentTimeMillis()
        }
        return RotationResult(done, skipped.toList())
    }

    /* The ids of this drive's items in the Trash, as the server lists them (a parent's listing leaves them out). */
    internal fun trashedIds(): Set<String> {
        val ids = HashSet<String>()
        var after: String? = null
        do {
            val page = api.trashListing(workspaceId, after)
            page.items.forEach { ids.add(it.node.id) }
            after = page.nextCursor
        } while (after != null)
        return ids
    }

    /* Whether the re-seal pass should run now: a key replacement is waiting to finish, or the last full pass is a day old. */
    fun resealDue(now: Long = System.currentTimeMillis()): Boolean {
        val seals = ShareSeals.of(context)
        return seals.pending != null || seals.queued.isNotEmpty() || now - seals.lastPass >= ShareSeals.PASS_INTERVAL_MS
    }

    /*
     * Rotates the subtree under `item` after a revoke; returns how many nodes were re-sealed and who was left out, and
     * why. Recorded first and cleared once it finishes, so one that stops (no trust set, no network) is tried again at
     * the next Drive open rather than left half done.
     */
    fun rotate(item: Opened, progress: (Int) -> Unit = {}): RotationResult {
        refuseFamilyWrite(item.node.workspaceId)
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
            val item = try {
                resolve(nodeId)
            } catch (error: NotFound) {
                // In the Trash it is left out of its folder's listing as a deleted item is; restored, it would still open
                // with the keys the stopped share had, so the rotation stays owed. Only a deletion lets it go.
                if (nodeId !in trashedIds()) pending.remove(ws, nodeId)
                continue
            }
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
        // Out of a family folder or into one: a change family folders don't take on Android yet.
        refuseFamilyWrite(source.node.workspaceId)
        refuseFamilyWrite(workspaceOf(parentId))
        val checked = trust ?: trustForWrite()
        val prior = Prior.of(source.node, checked)
        if (source.isFolder) {
            val made = createFolder(parentId, name ?: source.name, prior, source.metadata.attributes)
            for (child in listChildren(source.id)) copyAcross(child.id, made.id, null, checked, progress)
            return made
        }
        val directory = File(context.cacheDir, "copy-" + UUID.randomUUID())
        try {
            val file = File(directory, source.name)
            download(source.id, file) { progress(it / 2f) }
            val thumb = runCatching { thumbnail(source.id) }.getOrNull()
            return upload(file, name ?: source.name, source.metadata.mime, parentId, null, thumb, prior, source.metadata.attributes) { progress(0.5f + it / 2f) }
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
        refuseFamilyWrite(folder.node.workspaceId)
        if (folder.node.trashedAt != null) { Offline.forgetFolder(context, folder.id); return }
        // Recorded under the lock a family's proof purges kept copies under: never after a proof that already ran.
        synchronized(familyCopiesLock) {
            refuseFamilyWrite(folder.node.workspaceId)
            Offline.rememberFolder(context, folder, shareRoot)
        }
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
        refuseFamilyWrite(item.node.workspaceId)
        val destination = Offline.file(context, item) ?: throw ApiError(400, "Only files can be kept downloaded.")
        if (!destination.exists()) {
            // Renamed elsewhere: the same version is already here under its old name, so move it rather than fetch it again.
            val earlier = destination.parentFile?.listFiles()?.firstOrNull { it.isFile && !it.name.endsWith(".part") }
            if (earlier == null || !earlier.renameTo(destination)) {
                try {
                    download(item.id, destination, null, progress = progress)
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
        // Recorded under the lock a family's proof purges kept copies under: a folder proven a family's while this came
        // down (a share's) keeps nothing of it, and a proof after this finds and purges the entry.
        synchronized(familyCopiesLock) {
            try {
                refuseFamilyWrite(item.node.workspaceId)
            } catch (error: Exception) {
                File(Offline.root(context), item.id).deleteRecursively()
                throw error
            }
            // Older versions of the same file go; only the current one is kept.
            destination.parentFile?.parentFile?.listFiles()?.filter { it.name != item.node.currentVersion?.id }?.forEach { it.deleteRecursively() }
            Offline.remember(context, item, via)
        }
    }

    /*
     * Where a copy of `item` opened for the viewer, another app or Send a copy goes: a family file's under its family
     * folder's, a received share's under its workspace's (both deleted whole by a removal or a proof, whatever this
     * process remembers), this account's own under opened/<node>. Null when the workspace id can't name a folder.
     */
    fun openedCopyFolder(item: Opened): File? {
        val ws = item.node.workspaceId
        return when {
            isFamilyWorkspace(ws) -> FamilyCopies.folder(context.cacheDir, ws)
            ownWorkspaceId?.equals(ws, ignoreCase = true) == true -> File(context.cacheDir, "opened")
            else -> ShareCopies.folder(context.cacheDir, ws)
        }
    }

    /*
     * The one gate a family write's reply passes before it touches the cache, the ledger's rows or the screens (creates,
     * uploads, new versions and their name, renames, moves, restores and Undo), in this order: the write's own count (its
     * folder let go of since it began: a removal, a fork, a refusal, route 25 no longer listing it, said in the family's
     * words), then the session (ended: nothing more lands). Callers then apply the newer-row rule and only then open, keep
     * or show anything. Under familyCopiesLock, the lock a forget takes.
     */
    private fun requireWriteStands(workspaceId: String) {
        if (!isFamilyWorkspace(workspaceId) || WriteIntent.decision(workspaceId) != true) return
        val began = WriteIntent.epoch(workspaceId) ?: throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        familyWordsSince(workspaceId, began)?.let { throw FamilyFailure(it) }
        if (closed) throw SessionEnded()
    }

    /* A write's own refusal before anything was sent (the final gate's), told apart from the network's. */
    private fun <T> refusedHere(body: () -> T): T = try {
        body()
    } catch (refused: Exception) {
        if (refused is GuardUnsaved || refused is FamilyFailure || refused is FamilyUnavailable || refused is SessionEnded) throw UploadFinish.RefusedHere(refused)
        throw refused
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
    private fun workspaceOf(nodeId: String): String = nodes.find(nodeId)?.node?.workspaceId ?: familyNodes[nodeId] ?: workspaceId

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
        // The settings read once for the whole list, and one verdict per granter and the full identity served (MountPass).
        // Read up front, so settings that can't be had (offline, rolled back, signed out) fail the listing as before.
        val pass = MountPass().apply { settings = loadSettings() }
        return shares.map { share ->
            runCatching {
                // Before any key is opened: a share into this account's own drive, or for a node of another workspace, is refused.
                checkShare(share, own)
                // And one into a family's folder (proven, let go of, or held by a barrier still up): a family's items open
                // only through its area ledger, never under a key a share hands over. A member list's word alone outlasts
                // nothing: once that family's guard is stored, a share it named mounts as any other.
                val target = share.workspaceId.lowercase()
                if (shareIntoFamily(target)) throw ShareRefused("This share could not be checked.")
                checkSuite(share.node.envelopeSuite)
                val name = share.granterName.ifEmpty { share.granterEmail }
                val granter = try {
                    trustGranter(share, explicit = false, pass = pass)
                } catch (_: GuardUnreadable) {
                    throw GranterTrust.Unchecked()
                }
                val key = openShare(base64urlDecode(share.shareEnvelope), granter, name, identities,
                    ShareContext(share.workspaceId, share.node.id, share.keyEpoch, api.session.userId, share.granterId))
                val metadata = metadataOpen(MetadataContext(share.node.workspaceId, share.node.id, share.node.metadataVersion), key, base64urlDecode(share.node.metadataEnvelope))
                // Kept under the granter's workspace only (NodeCache.adoptShare). The root's parent is the granter's and
                // opens nothing here: it stays out of the parents index, which a share naming one of this drive's ids would rewrite.
                val row = openedRow(share.node, metadata, key)
                beforeKept?.invoke(target)
                // Checked again where it is kept, under the lock a family's proof, a forget and a session's end take: a
                // family proven, let go of or held meanwhile (while the granter was judged) gets nothing of the share.
                val kept = synchronized(familyCopiesLock) {
                    if (closed) throw SessionEnded()
                    if (shareIntoFamily(target)) throw ShareRefused("This share could not be checked.")
                    nodes.adoptShare(share, own, row, key)
                }
                ShareMount(share, kept, null)
            }.getOrElse {
                if (it is NotAuthenticated || it is Unreachable) throw it
                ShareMount(share, null, it.message ?: "This share could not be opened.", it as? GranterTrust, explained = it is Refused)
            }
        }
    }

    fun item(id: String): Opened? = nodes.find(id)

    /* A row by its workspace and id: never another workspace's row that has the same id (a personal file, a share). */
    fun item(workspaceId: String, id: String): Opened? =
        nodes.row(workspaceId, id)?.takeIf { !isFamilyWorkspace(workspaceId) || nodes.viaLedger(workspaceId, id) }

    /* The row while it is live: neither it nor a folder above it in the trash (NodeCache.live); in `workspaceId` when given. */
    fun liveItem(id: String, workspaceId: String? = null): Opened? = nodes.live(id, workspaceId)

    /* Whether this device holds a row for `id` at all, live or trashed; in `workspaceId` when given. */
    fun holds(id: String, workspaceId: String? = null): Boolean = (if (workspaceId != null) nodes.row(workspaceId, id) else nodes.find(id)) != null

    /* Whether the server said this workspace's node `id` is gone since this device last held it (NodeCache.remove). */
    fun removed(workspaceId: String, id: String): Boolean = nodes.gone(workspaceId, id)

    /* This account's own workspace once opened, without asking the server. */
    val ownWorkspaceId: String? get() = workspace?.workspaceId

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
        // A rotation here re-keyed the parent and hasn't reached this child: it is still wrapped under the previous key.
        rotatedKeys[node.workspaceId to parentId]?.let { kept ->
            if (kept.epoch != node.parentKeyEpoch && kept.previousEpoch == node.parentKeyEpoch) return kept.previousKey
        }
        return nodes.key(node.workspaceId, parentId) ?: throw ApiError(500, "Open the containing folder first.")
    }

    @Synchronized
    /*
     * `replace` (a listing's own rows): a row of this drive or a share served differently from the one held, and not older,
     * is opened afresh and kept in its place once it opened; until then, and if it can't be opened, the held one stays.
     */
    fun open(node: NodeView, replace: Boolean = false, writeEpoch: Long? = null): Opened {
        checkSuite(node.envelopeSuite)
        val family = isFamilyWorkspace(node.workspaceId)
        nodes.row(node.workspaceId, node.id)?.let { held ->
            // A family folder has no change feed here: a row served differently (another member's rename, a new version, a
            // walk's re-key) is opened again through the ledger, never answered from what this process opened before. An
            // older answer arriving after a newer one (listings out of order) keeps the newer row and key.
            // A family folder's row is answered from the cache only when its area ledger opened it: one a share mount
            // left there goes, and the ledger is asked.
            val trusted = !family || nodes.viaLedger(node.workspaceId, node.id)
            if (trusted && (sameRecords(held.node, node) || node.olderThan(held.node))) return held
            if (!family && !replace) return held
            if (family) {
                nodes.forget(node.workspaceId, node.id)
                nodes.dropKey(node.workspaceId, node.id)
            }
        }
        // One id, one workspace on this phone where a family is involved: a family row whose id another workspace's row
        // holds (a personal file, a share), or a row of another workspace whose id a family row holds, is refused, so no
        // lookup or list keyed by node id can mix a family's item with another's (a server serving colliding ids).
        val others = nodes.workspacesOf(node.id).filterNot { it.equals(node.workspaceId, ignoreCase = true) }
        if (family && others.isNotEmpty()) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        if (!family && others.any { isFamilyWorkspace(it) }) throw Refused("Couldn’t open", "This item couldn’t be checked. Try again later.")
        // A family folder's node opens only through the area ledger, under keys its member list vouches for, never the personal path.
        // Its folder's invalidation before the ledger is asked: a forget meanwhile (a removal, a fork) keeps what opened out of the cache.
        // A family write's reply opened again (an Undo's row) goes by the write's own count: a forget since it began keeps nothing.
        val epoch = if (family) writeEpoch ?: familyEpoch(node.workspaceId) else 0L
        val key = if (family) {
            familyNodes[node.id] = node.workspaceId
            areaLedger.openListedNode(node.workspaceId, servedKey(node)).also { afterFamilyOpen?.invoke() }
        } else {
            val ctx = NodeKeyContext(node.workspaceId, node.id, node.parentId ?: node.workspaceId, node.parentKeyEpoch, node.keyEpoch)
            nodeOpen(ctx, parentKeyFor(node), base64urlDecode(node.keyEnvelope))
        }
        val metadata = metadataOpen(MetadataContext(node.workspaceId, node.id, node.metadataVersion), key, base64urlDecode(node.metadataEnvelope))
        val result = openedRow(node, metadata, key)
        if (family) {
            // Kept under the lock a forget clears the cache under, and only while the folder stands: a stale open keeps nothing.
            synchronized(familyCopiesLock) {
                requireFamilyEpoch(node.workspaceId, epoch)
                // Checked again where it is kept: nothing newer the ledger opened is ever replaced by an older row.
                val held = nodes.row(node.workspaceId, node.id)
                if (held != null && nodes.viaLedger(node.workspaceId, node.id) && node.olderThan(held.node)) return held
                nodes.put(result, key, viaLedger = true)
            }
        } else {
            beforeKept?.invoke(node.workspaceId)
            // Under the lock a family's proof takes: a folder proven a family's since this open began keeps nothing opened
            // under a share's or this account's keys (its rows open through the ledger alone).
            synchronized(familyCopiesLock) {
                if (isFamilyWorkspace(node.workspaceId)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
                nodes.put(result, key)
            }
        }
        node.parentId?.let { parents[node.id] = it }
        return result
    }

    /* A node whose key this device made or already held (a write), kept under its own workspace. */
    private fun adopt(node: NodeView, key: ByteArray, metadata: NodeMetadata): Opened {
        checkSuite(node.envelopeSuite)
        val result = openedRow(node, metadata, key)
        // A write's answer into a folder proven a family's is kept only when the write decided at its entry to write as
        // the family's (its key the ledger's): then as the ledger's own row. One begun on another path is not kept: the
        // ledger opens it when listed.
        var newer: Opened? = null
        val kept = synchronized(familyCopiesLock) {
            if (!isFamilyWorkspace(node.workspaceId)) run { nodes.put(result, key); true }
            else if (WriteIntent.decision(node.workspaceId) == true) run {
                // The family write's reply gate first (its own count, then the session), then the newer-row rule, then kept.
                requireWriteStands(node.workspaceId)
                // Never over a newer row the ledger opened (a listing that landed first, another member's rename since): an
                // older answer keeps it, as open() does.
                val held = nodes.row(node.workspaceId, node.id)
                if (held != null && nodes.viaLedger(node.workspaceId, node.id) && node.olderThan(held.node)) {
                    newer = held
                    return@run false
                }
                nodes.put(result, key, viaLedger = true)
                familyNodes[node.id] = node.workspaceId
                true
            } else false
        }
        newer?.let { return it }
        if (!kept) return result
        fileWritten(node)
        node.parentId?.let { rememberParent(node.id, it) }
        return result
    }

    /* What a write answered with, kept only when it is the node written, in the workspace written to. */
    private fun adoptWritten(node: NodeView, key: ByteArray, metadata: NodeMetadata, workspaceId: String, nodeId: String): Opened {
        checkWritten(node, workspaceId, nodeId)
        return adopt(node, key, metadata)
    }

    /*
     * A write's row filed in this vault's catalogue at once (out of the folder it left, into the one it is in), so a
     * listing asked for right after the write, as Files asks once told, has it before the feed brings it.
     */
    private fun fileWritten(node: NodeView) {
        if (catalogueState != CatalogueState.READY || node.workspaceId != workspace?.workspaceId) return
        val parent = node.parentId ?: return
        nodes.row(node.workspaceId, node.id)?.node?.parentId?.let { old -> if (old != parent) catalogueChildren[old]?.remove(node.id) }
        catalogueChildren.getOrPut(parent) { ConcurrentHashMap.newKeySet() }.add(node.id)
    }

    /* Files and the pickers read these folders again (FilesRoots); every write that changes a folder's children ends here. */
    internal fun foldersChanged(folders: Collection<String?>) = FilesRoots.foldersChanged(context, folders.filterNotNull(), workspace?.root?.id)

    fun forget(workspaceId: String, id: String) {
        nodes.forget(workspaceId, id)
    }

    /* `forget`, for a row the server said is gone (trashed from here, tombstoned, purged): Info closes on it. */
    fun remove(workspaceId: String, id: String) {
        nodes.remove(workspaceId, id)
    }

    /* Every page of a folder, every key along the way opened; parents first, folders before files. */
    fun listChildren(folderId: String, workspaceId: String? = null): List<Opened> {
        // The catalogue answers first when it can, so a folder draws before the server is asked: only this account's own.
        if (workspaceId == null || workspaceId.equals(this.workspaceId, ignoreCase = true)) catalogueChildren(folderId)?.let { return it }
        // The workspace asked for (a family folder's), never one guessed by id alone.
        val ws = workspaceId ?: workspaceOf(folderId)
        var after: String? = null
        val children = ArrayList<Opened>()
        do {
            val page = api.children(folderId, ws, after)
            // Rows are opened only in the workspace asked about; one claiming another is not this folder's.
            if (page.folder.workspaceId != ws || page.folder.id != folderId) throw ApiError(502, "HushOS answered with a different folder.")
            // Parents first: the ancestors, then the folder, each refreshed from the page's own row where it differs (an owner's
            // re-key included), so the children open under the keys their new envelopes are wrapped in. Above a share's root
            // the keys are the granter's: those stay closed, and a row the page can't open keeps the one held.
            var pending = page.ancestors.filter { it.workspaceId == ws }
            repeat(pending.size) { pending = pending.filter { runCatching { open(it, replace = true) }.isFailure } }
            runCatching { open(page.folder, replace = true) }.onFailure { if (nodes.row(ws, page.folder.id) == null) throw it }
            for (child in page.children) {
                if (child.workspaceId != ws) continue
                // The listing's row is kept over a cached one that is older, or tied on every counter but different (a share's
                // row has no change order, and restoring an earlier version moves neither its key epoch nor its metadata
                // version), a move included. Nothing is evicted before the fresh row opened: one this phone can't open (a
                // parent key the page didn't carry) keeps the row held. A row in a later format stays out of the list;
                // anything else wrong with one it never held fails the folder, as before.
                val row = try {
                    open(child, replace = true)
                } catch (error: NewerFormat) {
                    continue
                } catch (error: Exception) {
                    nodes.row(ws, child.id) ?: throw error
                }
                // Only when the cache knows of a move this listing doesn't (its row is newer and under another folder) is
                // the row left out here: it belongs to its new folder.
                if (child.olderThan(row.node) && !row.node.parentId.equals(folderId, ignoreCase = true)) continue
                children.add(row)
                // A newer row kept over this older one keeps its own parent too (a move this listing doesn't know of).
                if (!child.olderThan(row.node)) parents[child.id] = folderId
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
    fun download(id: String, destination: File, version: VersionListView? = null, expectedVersionId: String? = null, workspaceId: String? = null,
                 progress: (Float) -> Unit = {}) {
        // A family file's folder may be let go of while this runs (a removal): what it was before anything is opened.
        val began = HashMap(familyEpochs)
        // The row of the workspace asked for, never another with the same id (resolve alone prefers this account's own).
        val item = if (workspaceId == null) resolve(id)
            else nodes.row(workspaceId, id) ?: run { resolve(id); nodes.row(workspaceId, id) } ?: throw NotFound("This item no longer exists.")
        val ws = item.node.workspaceId.lowercase()
        val family = isFamilyWorkspace(ws) || familyEpochs.containsKey(ws)
        // A family's file downloads only under the key its area ledger opened, never one a share mount left in the cache.
        if (family && !nodes.viaLedger(ws, item.id)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        val epoch = began[ws]?.first ?: 0L
        try {
            val v = openVersion(item, version)
            // The copy's path is keyed by the version the caller saw: another version never goes there.
            if (expectedVersionId != null && v.versionId != expectedVersionId) throw Refused("Couldn’t open", "It changed meanwhile. Try again.")
            var url = api.versionUrl(v.versionId, item.node.workspaceId)
            // Its folder made, each chunk written and the file kept only while this vault's session lasts and, for a family
            // file, while its folder stands, under the lock a forget and a session's end take: either they come after a
            // write (and the forget or the account's wipe deletes it), or nothing more is written.
            Resumable.download(destination, v.layout.chunkCount, v.layout.chunkBytes.toLong(),
                online = { Resumable.online(context) }, progress = progress, fileSize = v.content.plaintextSize.toLong(),
                onExpired = { url = api.versionUrl(v.versionId, item.node.workspaceId) },
                lock = familyCopiesLock, check = {
                    if (closed) throw SessionEnded()
                    if (family) requireFamilyEpoch(ws, epoch)
                    // Proven a family's folder since this began (a share's): nothing more is written under the share's key.
                    else if (isFamilyWorkspace(ws)) throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
                },
            ) { index -> chunkDecrypt(v.content, index, api.range(url, chunkRange(v.content.suite, v.content.plaintextSize, v.content.thumbnailBytes, index))) }
        } catch (error: Throwable) {
            // Let go of meanwhile: the family's words say why. Nothing is deleted here: what this download wrote went with
            // the forget (or the account's wipe), and whatever is at its paths now is a newer download's.
            if (family && !closed && familyEpoch(ws) != epoch) requireFamilyEpoch(ws, epoch)
            throw error
        }
    }

    /*
     * This vault's session ended (a sign-out, the account deleted, a lost session, another sign-in): no download of it
     * writes again, and every family folder it knew is let go of. `deleteCopies` when the account's copies were wiped
     * before this (deletion): what a download wrote between the wipe and now goes too.
     */
    fun close(deleteCopies: Boolean = false) = synchronized(familyCopiesLock) {
        // The session's end for every vault of it (the Files app's, a job's): the next vault of the session starts afresh.
        familyState.closed = true
        for (ws in familyAreas.keys + familyNodes.values.map { it.lowercase() } + familyEpochs.keys)
            familyEpochs.compute(ws) { _, old -> ((old?.first ?: 0L) + 1) to FamilyWords.OPEN_AGAIN }
        if (deleteCopies) for (folder in DecryptedCopies.FOLDERS) File(context.cacheDir, folder).deleteRecursively()
    }

    fun thumbnail(id: String, workspaceId: String? = null): ByteArray? {
        // The workspace's own row of the id, never another's (resolve alone prefers this account's own).
        val item = if (workspaceId == null) resolve(id) else nodes.row(workspaceId, id) ?: return null
        if (isFamilyWorkspace(item.node.workspaceId) && !nodes.viaLedger(item.node.workspaceId, item.id)) return null
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

    /* What changed lately (`Recents`); from the tail of the change feed until the catalogue can answer. */
    fun recents(limit: Int = 60, keep: (Opened) -> Boolean = { true }): Recents {
        catalogueRecents(limit, keep)?.let { return it }
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
        return Recents(items, limit, keep) { nodes.find(it)?.node?.parentId ?: parents[it] }
    }

    fun versions(id: String): List<VersionListView> = api.versions(id, resolve(id).node.workspaceId)

    // Writes

    /*
     * `copy`: set when the name comes from a record that existed before (a copy, a save from a link); see Prior.
     * `attributes`: a copied folder's source's, carried whole (keys this app doesn't know included); none for a new one.
     */
    fun createFolder(parentId: String, name: String, copy: Prior? = null, attributes: Map<String, String> = emptyMap()): Opened = writing {
        // Shared folders belong to the granter's workspace; an editor writes there, and the id is minted there.
        val parent = resolve(parentId)
        val ws = parent.node.workspaceId
        // A family folder takes a new folder through its ledger; a copy into one isn't offered.
        val family = if (copy != null) { refuseFamilyWrite(ws); false } else familyTarget(ws)
        if (!family) nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        val epoch = api.allocateEpoch(ws)
        val made = IdField.NODE.mint(ws)
        val id = made.id
        val (key, wrapped) = newNodeKey(id, parent, epoch, family)
        try {
            val metadata = NodeMetadata(typedName(name), null, null, null, attributes)
            val sealed = metadataSeal(MetadataContext(ws, id, 1uL), key, metadata)
            val signature = if (copy != null) signCopiedMetadata(ws, id, NodeKind.FOLDER, sealed, copy) else signMetadata(ws, id, NodeKind.FOLDER, 1uL, sealed)
            sendingIntoFamily(ws)
            val node = api.createFolder(ws, JSONObject().putId(made).put("parentId", parent.id).put("keyEpoch", epoch.toLong())
                .put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEnvelope", base64urlEncode(wrapped)).put("metadataEnvelope", base64urlEncode(sealed))
                .put("metadataSignature", signature))
            adoptWritten(node, key, metadata, ws, id).also { foldersChanged(listOf(parent.id)) }
        } catch (error: Exception) {
            // The server didn't take it: the key the ledger made for it goes (the web's forgetNodeKey).
            if (family) areaLedger.forgetNodeKey(ws, id)
            throw error
        }
    }

    fun rename(id: String, name: String): Opened = writing {
        val item = resolve(id)
        val family = familyTarget(item.node.workspaceId)
        // In a family folder only the ledger's writable key, at the epoch it was opened at.
        val key = if (family) writableKey(item) else nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val metadata = item.metadata.copy(name = typedName(name))
        val next = item.node.metadataVersion + 1uL
        // The type, size and date are carried over into the re-signed record: signed as it checked, never vouched for blind;
        // in a family folder as its member list judges it.
        val prior = if (family) familyPrior(FamilySync.metadataRecord(item.node), item.node.workspaceId) else replacedNamePrior(item)
        val sealed = metadataSeal(MetadataContext(item.node.workspaceId, id, next), key, metadata)
        sendingIntoFamily(item.node.workspaceId)
        val node = api.rename(id, item.node.workspaceId, item.node.metadataVersion, item.node.keyEpoch, base64urlEncode(sealed),
            signMetadata(item.node.workspaceId, id, if (item.isFolder) NodeKind.FOLDER else NodeKind.FILE, next, sealed, prior))
        adoptWritten(node, key, metadata, item.node.workspaceId, id).also { foldersChanged(listOf(item.node.parentId, it.node.parentId)) }
    }

    /* A node's key wrapped under a new parent's; both in one workspace, or the envelope would name the wrong one. */
    private fun rewrap(item: Opened, parent: Opened): String {
        if (!parent.node.workspaceId.equals(item.node.workspaceId, ignoreCase = true)) throw ApiError(400, "Move it within one drive.")
        // The key choke point of a move: a family folder's item is re-wrapped by the ledger, under a parent rooted at the
        // folder's current key only; never a family folder's key wrapped outside it.
        if (familyTarget(item.node.workspaceId)) {
            requireGuardKept(parent.node.workspaceId)
            return try {
                base64urlEncode(areaLedger.rewrapNode(item.node.workspaceId, item.id, parent.id, parent.node.keyEpoch, item.node.keyEpoch))
            } catch (refused: com.hushos.core.CoreException) {
                throw FamilyFailure(FamilyWords.keyChangeWords(refused.message.orEmpty()))
            }
        }
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        return base64urlEncode(nodeWrap(NodeKeyContext(item.node.workspaceId, item.id, parent.id, parent.node.keyEpoch, item.node.keyEpoch), parentKey, key))
    }

    fun move(id: String, parentId: String): Opened = writing {
        val item = resolve(id)
        val parent = resolve(parentId)
        // Within one family folder through the ledger (rewrap); across spaces nothing moves.
        familyTarget(item.node.workspaceId)
        familyTarget(parent.node.workspaceId)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val wrapped = rewrap(item, parent)
        sendingIntoFamily(item.node.workspaceId)
        val node = api.move(id, item.node.workspaceId, parent.id, parent.node.keyEpoch, wrapped)
        // Both listings change: the folder it left and the one it entered.
        adoptWritten(node, key, item.metadata, item.node.workspaceId, id).also { foldersChanged(listOf(item.node.parentId, parent.id)) }
    }

    /*
     * A copy under `parentId`: the server keeps the object; the envelopes are resealed here under a fresh node key.
     * Folders go node by node. Each record is checked first, as a reading would: the copy is signed with the ordinary
     * statement where its source verified, the saved one where it was saved from a link, re-sealed otherwise. Without
     * a trust set nothing is copied.
     */
    fun copy(id: String, parentId: String, name: String? = null, trust: Trust? = null): Opened = writing { copyInside(id, parentId, name, trust) }

    private fun copyInside(id: String, parentId: String, name: String? = null, trust: Trust? = null): Opened {
        val source = resolve(id)
        val parent = resolve(parentId)
        val ws = parent.node.workspaceId
        refuseFamilyWrite(source.node.workspaceId)
        refuseFamilyWrite(ws)
        val parentKey = nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
        val newName = typedName(name ?: source.name)
        val checked = trust ?: trustForWrite()
        val prior = Prior.of(source.node, checked)
        if (source.isFolder) {
            val made = createFolder(parent.id, newName, prior, source.metadata.attributes)
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
        sendingIntoFamily(ws)
        val node = api.copy(source.id, ws, JSONObject().put("sourceVersionId", version.id)
            .put("node", JSONObject().putId(madeNode).put("parentId", parent.id).put("parentKeyEpoch", parent.node.keyEpoch.toLong()).put("keyEpoch", epoch.toLong())
                .put("keyEnvelope", base64urlEncode(keyEnvelope)).put("metadataEnvelope", base64urlEncode(metadataEnvelope))
                .put("metadataSignature", signCopiedMetadata(ws, newId, NodeKind.FILE, metadataEnvelope, prior)))
            .putId(madeVersion).put("contentKeyEnvelope", base64urlEncode(contentKeyEnvelope))
            .put("versionSignature", signCopiedVersion(ws, newId, versionId, version.objectId, version.contentSuite, contentKeyEnvelope, prior)))
        return adoptWritten(node, key, metadata, ws, newId).also { foldersChanged(listOf(parent.id)) }
    }

    fun trash(id: String) = writing {
        val parent = resolve(id).node.parentId
        val workspace = sendTrash(id)
        remove(workspace, id)
        foldersChanged(listOf(parent))
    }

    /* The single route's trash, without forgetting the row: its workspace, for the caller to forget it once the lists let go. */
    private fun sendTrash(id: String): String {
        val item = resolve(id)
        // Nothing is sealed, but a family folder takes it only while this device may write there.
        familyTarget(item.node.workspaceId)
        sendingIntoFamily(item.node.workspaceId)
        api.trash(id, item.node.workspaceId)
        return item.node.workspaceId
    }

    /*
     * Move to Trash for many, one outcome per id in order, `moved` told of each id as its request's
     * answer lands: the one place a selection reaches the server. The batch route, 200 ids a
     * request and a request per workspace (TrashBatches.kt); one request an item on a server
     * without it. What moved leaves this device's rows at once.
     */
    suspend fun trashMany(ids: List<String>, moved: (List<String>) -> Unit = {}): List<Result<TrashMove>> = writingSuspend {
        val all = ids.map { id -> id to (nodes.find(id)?.node?.workspaceId ?: runCatching { resolve(id).node.workspaceId }.getOrDefault(workspaceId)) }
        // A family folder takes it only while this device may write there: a refusal (a guard owed, keys changed) is each
        // of its items' failure, said as any batch's, and the rest go on.
        val refused = refusedWorkspaces(all.map { it.second })
        val items = all.filter { it.second.lowercase() !in refused }
        val workspaces = items.toMap()
        // Read before the rows are forgotten: the folders whose listings lose what moved.
        val parentsOf = ids.associateWith { id -> nodes.find(id)?.node?.parentId ?: parents[id] }
        trashInBatches(
            items,
            send = { ws, chunk -> api.trashBatch(ws, chunk) },
            // One request an item: each row leaves the lists, then this device forgets it, as for a batch.
            sequential = { chunk ->
                trashEach(chunk, { id -> sendTrash(id) }) { id -> moved(listOf(id)); workspaces[id]?.let { remove(it, id) } }
                    .map { outcome -> outcome.map { TrashMove.TRASHED } }
            },
            ancestors = { id -> nodes.find(id)?.let { ancestorIds(it) }.orEmpty() },
            // Called after `moved`: the row leaves the lists first, then this device forgets it.
            forget = { landed -> for (id in landed) workspaces[id]?.let { remove(it, id) } },
            moved = { landed -> moved(landed.map { it.first }) },
        ).also { outcomes -> foldersChanged(items.filterIndexed { index, _ -> outcomes[index].isSuccess }.map { parentsOf[it.first] }.distinct()) }
            .let { outcomes -> mergeRefused(all.map { it.second }, refused, outcomes) }
    }

    /* The workspaces of a batch whose family folders may not be written now, each with its refusal (an ended session ends the batch). */
    private fun refusedWorkspaces(workspaces: List<String>): Map<String, Exception> {
        val refused = HashMap<String, Exception>()
        for (ws in workspaces.distinct()) try {
            familyTarget(ws)
        } catch (error: Exception) {
            if (error is NotAuthenticated) throw error
            refused[ws.lowercase()] = error
        }
        return refused
    }

    /* A batch's outcomes in its items' order: a refused workspace's items failed with its refusal, the rest as sent. */
    private fun <T> mergeRefused(workspaces: List<String>, refused: Map<String, Exception>, sent: List<Result<T>>): List<Result<T>> {
        val outcomes = sent.iterator()
        return workspaces.map { ws -> refused[ws.lowercase()]?.let { Result.failure(it) } ?: outcomes.next() }
    }

    /*
     * Undo for trashMany: the items back in place through the batch route (folders before what is
     * in them, `parent-trashed` tried again once the rest landed), or one request an item on a
     * server without it. One outcome per item in order, the restored row on success; `back` hears
     * each row as it lands.
     */
    suspend fun restoreMany(asked: List<Opened>, back: (Opened) -> Unit = {}): List<Result<Opened>> = writingSuspend {
        // Back in place (a trash's Undo), in a family folder only while this device may write there: a refusal is each of
        // its items' failure, said as any Undo's, and the rest come back.
        val refused = refusedWorkspaces(asked.map { it.node.workspaceId })
        val items = asked.filter { it.node.workspaceId.lowercase() !in refused }
        val given = items.associateBy { it.id }
        val rows = java.util.concurrent.ConcurrentHashMap<String, Opened>()
        val outcomes = restoreInBatches(
            items.map { it.id to it.node.workspaceId },
            depth = { id -> ancestorIds(given.getValue(id)).count { it in given } },
            send = { ws, chunk ->
                api.restoreBatch(ws, chunk).onEach { answer -> if (answer is Restored) rows[answer.id] = restoredRow(given.getValue(answer.id), answer.changeSeq) }
            },
            sequential = { chunk -> chunk.map { id -> runCatching { rows[id] = restore(TrashItem(given.getValue(id), false)) } } },
            back = { id -> rows[id]?.let(back) },
        )
        foldersChanged(rows.values.map { it.node.parentId }.distinct())
        mergeRefused(asked.map { it.node.workspaceId }, refused, items.mapIndexed { index, item -> outcomes[index].map { rows.getValue(item.id) } })
    }

    /* The folders above an item, nearest first, as far as this device knows them. */
    private fun ancestorIds(item: Opened): List<String> {
        val chain = ArrayList<String>()
        var cursor = item.node.parentId
        while (cursor != null && chain.size < 256) {
            chain.add(cursor)
            cursor = nodes.find(cursor)?.node?.parentId ?: parents[cursor]
        }
        return chain
    }

    /* A row the batch put back: the one this device holds, out of the trash, with the server's change number. */
    private fun restoredRow(item: Opened, changeSeq: Int): Opened {
        val ws = item.node.workspaceId
        val family = isFamilyWorkspace(ws) && WriteIntent.decision(ws) == true
        // A family Undo's reply passes the write's reply gate before anything is opened, kept or shown, and its row is
        // opened again under the write's own count, so a forget since it began keeps nothing and shows nothing.
        if (family) synchronized(familyCopiesLock) { requireWriteStands(ws) }
        val row = nodes.row(ws, item.id) ?: (if (family) open(item.node, writeEpoch = WriteIntent.epoch(ws)) else runCatching { open(item.node) }.getOrNull()) ?: item
        val key = nodes.key(row) ?: return row.copy(node = row.node.copy(trashedAt = null, changeSeq = changeSeq))
        return adopt(row.node.copy(trashedAt = null, changeSeq = changeSeq), key, row.metadata)
    }

    fun restore(entry: TrashItem): Opened = writing {
        // In a family folder only back where it was (a trash's Undo): under the top folder would re-wrap under the
        // account's own root, which no family folder's item can be.
        if (isFamilyWorkspace(entry.item.node.workspaceId) && entry.parentTrashed) throw FamilyUnavailable()
        familyTarget(entry.item.node.workspaceId)
        val item = nodes.row(entry.item.node.workspaceId, entry.item.id) ?: open(entry.item.node)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        val toRoot = if (entry.parentTrashed) resolve(rootId).let { root -> root.node.keyEpoch to rewrap(item, root) } else null
        sendingIntoFamily(item.node.workspaceId)
        val node = api.restore(item.id, item.node.workspaceId, toRoot)
        adoptWritten(node, key, item.metadata, item.node.workspaceId, item.id).also { foldersChanged(listOf(it.node.parentId)) }
    }

    fun purge(id: String) {
        val ws = workspaceId
        api.purge(id, ws)
        remove(ws, id)
    }

    fun emptyTrash(): EmptyTrashResult = api.emptyTrash(workspaceId)

    fun restoreVersion(version: VersionListView, id: String): Opened {
        val item = resolve(id)
        refuseFamilyWrite(item.node.workspaceId)
        val key = nodes.key(item) ?: throw ApiError(500, "Node not opened")
        // Its size and date change in its folder's listing.
        return adoptWritten(api.restoreVersion(version.id, item.node.workspaceId), key, item.metadata, item.node.workspaceId, id).also { foldersChanged(listOf(it.node.parentId)) }
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
     * written to, fresh for each call: an attempt that stops starts over with new ids and seeds. `attributes`: a copy's
     * source's, for a new node; a new version keeps the replaced file's whatever is passed.
     */
    /*
     * Every reservation goes through Reservations: on record from `begin` until definitely settled. `job`: the queued
     * job this upload runs in ("" outside one); it never reserves while an older record of that job is unsettled.
     */
    fun upload(file: File, name: String, mime: String?, parentId: String, replacing: Opened?, thumbnail: ByteArray? = null, copy: Prior? = null,
               attributes: Map<String, String> = emptyMap(), job: String = "", progress: (Float) -> Unit = {}): Opened = writing {
        uploadInside(file, name, mime, parentId, replacing, thumbnail, copy, attributes, job, progress)
    }

    /* An abort of this vault's reservation, applied to the ledger: its record goes only when the answer settled it (true). */
    private fun abortReserved(uploadId: String, workspaceId: String): Boolean =
        Reservations.aborted(context, uploadId, api.abortUpload(uploadId, workspaceId))

    private fun uploadInside(file: File, name: String, mime: String?, parentId: String, replacing: Opened?, thumbnail: ByteArray?, copy: Prior?,
                             attributes: Map<String, String>, job: String, progress: (Float) -> Unit): Opened {
        // The workspace written to: the replaced file's, or the folder's (a share's subtree is the granter's).
        val ws = replacing?.node?.workspaceId ?: resolve(parentId).node.workspaceId
        // A family folder takes a file or a new version through its ledger; a copy into one isn't offered.
        val family = if (copy != null) { refuseFamilyWrite(ws); false } else familyTarget(ws)
        // A new version carries the old name over into metadata signed again: checked before any byte goes up, so an
        // unverified name is re-sealed rather than vouched for, and nothing is uploaded when the check can't run. In a
        // family folder as its member list judges it.
        val keptName = replacing?.let { if (family) familyPrior(FamilySync.metadataRecord(it.node), ws) else replacedNamePrior(it) }
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
        // A new family node's key the ledger made: dropped if the server never takes the node.
        var madeKey: String? = null
        val nodeInput: JSONObject
        val metadata: NodeMetadata
        if (replacing != null) {
            nodeId = replacing.id
            // In a family folder the version goes under the ledger's writable key only, at the epoch it was opened at.
            nodeKey = if (family) writableKey(replacing) else nodes.key(replacing) ?: throw ApiError(500, "Node not opened")
            nodeInput = JSONObject().put("existing", true).put("id", nodeId).put("keyEpoch", replacing.node.keyEpoch.toLong())
                .put("expectedVersionId", replacing.node.currentVersion?.id ?: JSONObject.NULL)
            metadata = replacing.metadata
        } else {
            val parent = resolve(parentId)
            if (parent.node.workspaceId != ws) throw ApiError(400, "Upload it within one drive.")
            if (!family) nodes.key(parent) ?: throw ApiError(500, "Open the containing folder first.")
            val epoch = api.allocateEpoch(ws)
            val madeNode = IdField.NODE.mint(ws)
            nodeId = madeNode.id
            val made = newNodeKey(nodeId, parent, epoch, family)
            madeKey = nodeId.takeIf { family }
            nodeKey = made.first
            val wrapped = made.second
            metadata = newFileMetadata(name, mime, size, modified, attributes)
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
        // A job's earlier reservation first: settled, or nothing new is reserved (the network's: the job runs again later).
        if (job.isNotEmpty()) {
            val earlier = Reservations.settleJob(context, job) { id, at -> api.abortUpload(id, at) }
            if (earlier != Reservations.Settle.CLEAR) madeKey?.let { areaLedger.forgetNodeKey(ws, it) }
            if (earlier == Reservations.Settle.PENDING) throw Unreachable()
            // It completed after all: the file is there, so this one is never sent again.
            if (earlier == Reservations.Settle.LANDED) throw Reservations.LandedEarlier()
        }
        val beganAt = Reservations.now()
        val begun = try {
            api.beginUpload(ws, JSONObject().put("node", nodeInput).putId(madeVersion).putId(madeObject)
            .put("contentKeyEnvelope", base64urlEncode(version.envelope)).put("contentNonce", base64urlEncode(contentNonce))
            .put("versionSignature", versionSignature)
            .put("contentSuite", suite.toInt()).put("chunkCount", layout.chunkCount.toLong()).put("ciphertextSize", layout.ciphertextSize.toString())
            .also { sendingIntoFamily(ws) })
        } catch (error: Exception) {
            madeKey?.let { areaLedger.forgetNodeKey(ws, it) }
            throw error
        }
        try {
            Reservations.reserved(context, begun.uploadId, ws, job, beganAt, begun.expiresAt)
        } catch (error: Exception) {
            // The ledger couldn't be written (a full disk): the reservation is held in memory and aborted at once. Settled, the
            // write's failure is the job's; not, the job is the network's and reserves nothing more in this process meanwhile.
            val settled = runCatching { abortReserved(begun.uploadId, ws) }.getOrDefault(false)
            madeKey?.let { areaLedger.forgetNodeKey(ws, it) }
            if (!settled) throw Unreachable()
            throw error
        }
        try {
            return uploadReserved(file, mime, ws, nodeId, nodeKey, metadata, replacing, keptName, madeKey, begun, layout, content, thumbnail, thumbnailBytes, size, modified, progress)
        } finally {
            Reservations.idle(begun.uploadId)
        }
    }

    /* The upload after its reservation is on record: parts, completion, the name of a new version. */
    private fun uploadReserved(file: File, mime: String?, ws: String, nodeId: String, nodeKey: ByteArray, metadata: NodeMetadata, replacing: Opened?,
                               keptName: Integrity?, madeKey: String?, begun: UploadBegun, layout: com.hushos.core.ContentLayout, content: Content,
                               thumbnail: ByteArray?, thumbnailBytes: UInt, size: ULong, modified: String, progress: (Float) -> Unit): Opened {
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
            abortReserved(begun.uploadId, ws)
            madeKey?.let { areaLedger.forgetNodeKey(ws, it) }
            throw error
        }
        // Refused: aborted, so its reserved room is released now. Unknown: asked again, never aborted blind (UploadFinish).
        // A completion the final gate refuses here (a guard owed, the folder no longer writable, the session ended) was never
        // sent: a definite answer, so the upload is aborted and its room released, and a new node's ledger key goes.
        var node = try {
            UploadFinish.complete({ refusedHere { api.completeUpload(begun.uploadId, ws, etags) } }, { abortReserved(begun.uploadId, ws) })
        } catch (refused: UploadFinish.RefusedHere) {
            madeKey?.let { areaLedger.forgetNodeKey(ws, it) }
            throw refused.cause!!
        } ?: throw ApiError(500, "Upload completed without a node")
        // Completed: the reservation became the file.
        Reservations.settled(context, begun.uploadId)
        checkWritten(node, ws, nodeId)
        var final = metadata
        if (replacing != null) {
            // The name is signed again only while the family write still stands (its reply gate, before anything is sealed).
            synchronized(familyCopiesLock) { requireWriteStands(ws) }
            // A new version has a new size and date; the sealed metadata says so too, as the lists read it.
            final = metadata.copy(mime = mime ?: metadata.mime, size = size, modified = modified)
            val next = node.metadataVersion + 1uL
            val sealed = metadataSeal(MetadataContext(ws, nodeId, next), nodeKey, final)
            node = api.rename(nodeId, ws, node.metadataVersion, node.keyEpoch, base64urlEncode(sealed), signMetadata(ws, nodeId, NodeKind.FILE, next, sealed, keptName))
        }
        // Told once it has landed, wherever it was started from (the app, a transfer job, Files writing a file back).
        return adoptWritten(node, nodeKey, final, ws, nodeId).also { foldersChanged(listOf(it.node.parentId)) }
    }
}

/* A download whose session ended while it ran: nothing more of it is written. */
class SessionEnded : java.io.IOException("You signed out.")
