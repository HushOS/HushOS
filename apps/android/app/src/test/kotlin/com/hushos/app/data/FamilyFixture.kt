package com.hushos.app.data

import android.content.Context
import com.hushos.core.AcceptedRosters
import com.hushos.core.AreaGrantContext
import com.hushos.core.AreaKey
import com.hushos.core.GroupAnchor
import com.hushos.core.GroupKind
import com.hushos.core.GroupPin
import com.hushos.core.GroupRole
import com.hushos.core.IdKind
import com.hushos.core.MemberStatus
import com.hushos.core.NodeMetadata
import com.hushos.core.OwnIdentities
import com.hushos.core.Roster
import com.hushos.core.RosterChain
import com.hushos.core.RosterMember
import com.hushos.core.ServedKeys
import com.hushos.core.SignedGroupStatement
import com.hushos.core.acceptRosters
import com.hushos.core.areaGrantSeal
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.deviceRemember
import com.hushos.core.groupPublicKey
import com.hushos.core.groupSeedCreate
import com.hushos.core.identityCreate
import com.hushos.core.identityOpen
import com.hushos.core.identityUpgrade
import com.hushos.core.newId
import com.hushos.core.NodeKeyContext
import com.hushos.core.MetadataContext
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.metadataSign
import com.hushos.core.nodeWrap
import com.hushos.core.pinAfter
import com.hushos.core.previousRootKeyWrap
import com.hushos.core.rosterNext
import com.hushos.core.GroupKeySealContext
import com.hushos.core.GroupSignature
import com.hushos.core.groupKeySeal
import com.hushos.core.randomBytes
import com.hushos.core.rosterDigest
import com.hushos.core.rosterFirst
import com.hushos.core.rosterSign
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/* Base64url of SHA-256, as rosters name ML-DSA and ML-KEM keys. */
fun digest(value: String): String = base64urlEncode(MessageDigest.getInstance("SHA-256").digest(base64urlDecode(value)))

/* An account with an upgraded identity of its own, as the server would serve it. */
fun newPerson(): FakeDrive.Person {
    val id = UUID.randomUUID().toString()
    val root = randomBytes(32u)
    var envelope = identityCreate(id, root, 1uL)
    if (identityOpen(id, root, envelope).identityVersion == 1u) envelope = identityUpgrade(id, root, envelope)
    return FakeDrive.Person(id, envelope, identityOpen(id, root, envelope))
}

fun FakeDrive.Person.servedKeys() = ServedKeys(keys.keyVersion, keys.encryptionPublicKey, keys.signingPublicKey, keys.mlDsaPublicKey!!, keys.kemPublicKey!!)

fun FakeDrive.Person.entry(roles: List<GroupRole>, since: ULong) = RosterMember(id.lowercase(), keys.keyVersion, keys.encryptionPublicKey, keys.signingPublicKey,
    digest(keys.mlDsaPublicKey!!), digest(keys.kemPublicKey!!), MemberStatus.ACTIVE, roles, since)

/*
 * A family as the web makes one, served by FakeDrive (iOS's FamilyFixture): Sam (the creator) signs roster 1 with one
 * family folder, its key and its top folder's key committed, lets the account (Maya, the member) in at roster 2 with a
 * grant of the folder's key, and makes her the organizer at roster 3 (or, on a server's other branch, a guardian). Sam
 * wrote a file into the folder. The group routes (2, 3, 5, 6, 14, 15, 23, 25) are answered from here.
 */
class FamilyFixture(val server: FakeDrive) {
    val creator: FakeDrive.Person = newPerson()
    val member = server.me
    val groupId: String = newId(IdKind.GROUP, creator.id).id
    private val groupSeed = groupSeedCreate()
    private val area = newId(IdKind.WORKSPACE, groupId)
    val workspaceId: String = area.id
    private val areaKey = randomBytes(32u)
    private val rootKey = randomBytes(32u)
    private val owner = creator.entry(listOf(GroupRole.BILLING, GroupRole.MEMBERS), 1uL)
    val r1: SignedGroupStatement = rosterSign(rosterFirst(groupId, GroupKind.FAMILY, owner, listOf(AreaKey(workspaceId, areaKey, rootKey)), 2u), groupSeed, creator.keys)
    private fun next(previous: SignedGroupStatement, version: ULong, entry: RosterMember): SignedGroupStatement =
        rosterSign(Roster(groupId, GroupKind.FAMILY, version, rosterDigest(previous.statement), 1uL, creator.id, listOf(owner, entry).sortedBy { it.userId }, emptyList(), 2u),
            groupSeed, creator.keys)
    val r2 = next(r1, 2uL, member.entry(emptyList(), 2uL))
    val r3 = next(r2, 3uL, member.entry(listOf(GroupRole.BILLING), 3uL))
    val r3Fork = next(r2, 3uL, member.entry(listOf(GroupRole.GUARDIAN), 3uL))
    /* Another roster 2 on the same roster 1: what a server shows instead of r2. */
    val r2Other = next(r1, 2uL, member.entry(listOf(GroupRole.GUARDIAN), 2uL))
    val r4Fork = next(r3Fork, 4uL, member.entry(emptyList(), 4uL))
    /* Every signer's ML-DSA key by digest, as route 5 serves them: Sam's, and Maya's once she signs as a manager. */
    val signerKeys = mapOf(digest(creator.keys.mlDsaPublicKey!!) to creator.keys.mlDsaPublicKey!!, digest(member.keys.mlDsaPublicKey!!) to member.keys.mlDsaPublicKey!!)
    private val grant: ByteArray = run {
        val chain = (acceptRosters(groupId, groupPublicKey(groupSeed), GroupAnchor.CREATED, emptyList(), listOf(r1, r2), emptyList(), signerKeys,
            OwnIdentities(creator.id, listOf(creator.servedKeys())), null) as RosterChain.Accepted).chain
        areaGrantSeal(areaKey, AreaGrantContext(groupId, workspaceId, 1uL, member.id.lowercase(), member.keys.keyVersion, creator.id, 2uL, rosterDigest(r2.statement)),
            chain, area.seed, base64urlDecode(member.keys.kemPublicKey!!), creator.keys)
    }
    val rootId: String = newId(IdKind.NODE, workspaceId).id
    val fileId: String

    init {
        server.seedWorkspace(workspaceId, areaKey, creator)
        server.seedNodeWith(workspaceId, null, "folder", NodeMetadata("Photos", null, null, null, emptyMap()), rootId, rootKey, parentEpoch = 1L, epoch = 1L)
        fileId = server.file(rootId, "Recipes.txt", "marker-family".toByteArray())
        server.extraRoutes = ::route
    }

    // The server's side.
    @Volatile var chain: List<SignedGroupStatement> = listOf(r1, r2)
    /* The family folder's key version route 25 serves, and the grant of it to Maya. */
    @Volatile private var areaVersion = 1L
    @Volatile private var grantRow: JSONObject = JSONObject().put("workspaceKeyVersion", 1).put("granteeKeyVersion", member.keys.keyVersion.toLong())
        .put("granterUserId", creator.id).put("rosterVersion", 2).put("rosterDigest", rosterDigest(r2.statement)).put("envelope", base64urlEncode(grant))
    /* The key change route 25 names in the folder: its run id, from the top folder, to this epoch. */
    @Volatile var run: Triple<String, String, Long>? = null
    /* Route 8's seal of the group key to Maya (a manager), or none. */
    @Volatile var keySeal: JSONObject? = null
    /* Route 16: who waits to be let in, as JSON rows. */
    val pendingRows = java.util.Collections.synchronizedList(ArrayList<JSONObject>())
    /* Every body routes 17 and 18 were sent, in order, byte for byte. */
    val callBodies = java.util.Collections.synchronizedList(ArrayList<String>())
    /* How route 17 answers each call, in turn (empty: apply it as the server would). Each sees the body. */
    val admitAnswers = java.util.concurrent.ConcurrentLinkedQueue<(JSONObject) -> Pair<Int, JSONObject>?>()
    /* Routes 11, 13 and 26 (invite, cancel an invitation, turn down): answered with this while set, else taken. */
    @Volatile var manageAnswer: Pair<Int, JSONObject>? = null
    /* Route 12: the invitations still open, as JSON rows; route 13 takes one away. */
    val invitationRows = java.util.Collections.synchronizedList(ArrayList<JSONObject>())
    /* Route 12's answer instead of the rows (a failure, a lost session), while set. */
    @Volatile var invitationsAnswer: Pair<Int, JSONObject>? = null
    /*
     * Rows a request answered on this thread reads instead of the current ones: a read made before a change whose answer
     * arrives after it (set from FakeDrive.beforeAnswer, which runs on the request's own thread).
     */
    val readBefore = ThreadLocal<List<JSONObject>?>()
    /* Route 16's answer instead of the rows (a failure, a lost session), while set. */
    @Volatile var pendingAnswer: Pair<Int, JSONObject>? = null
    /* Route 22: each grants post (workspace, body), and how it is answered (null: taken). */
    val grantPosts = java.util.Collections.synchronizedList(ArrayList<Pair<String, String>>())
    @Volatile var grantsAnswer: Pair<Int, JSONObject>? = null

    /* Route 18 (a role change): how each call is answered, in turn (empty: applied as the server would). */
    val memberAnswers = java.util.concurrent.ConcurrentLinkedQueue<(JSONObject) -> Pair<Int, JSONObject>?>()
    /* Every route 18 call, by whom it changes and its body, in order. */
    val memberCalls = java.util.Collections.synchronizedList(ArrayList<Pair<String, String>>())
    /* A person's name and address as route 3 names them: Grace's, or what FakeDrive.another was given. */
    private fun nameOf(person: FakeDrive.Person) = if (person.id == server.grace.id) "Grace Hopper" else server.others.values.firstOrNull { it.first.id == person.id }?.second ?: "Someone"
    private fun emailOf(person: FakeDrive.Person) = if (person.id == server.grace.id) "grace@example.org" else server.others.entries.firstOrNull { it.value.first.id == person.id }?.key ?: ""

    /* People let in since (route 17): routes 3 and 6 name them and serve their identities beside Sam's and Maya's. */
    val joined = java.util.Collections.synchronizedList(ArrayList<FakeDrive.Person>())
    /* The successions the chain carries (a manager role taken away replaces the family's key), served on route 5. */
    val successions = java.util.Collections.synchronizedList(ArrayList<SignedGroupStatement>())

    /* Route 20's answer: null leaves (and the server then answers not-member), else this refusal. */
    @Volatile var leaveRefusal: Pair<Int, JSONObject>? = null
    /* What each leave asked to end (`endsLapsed`). */
    val leaves = java.util.Collections.synchronizedList(ArrayList<List<String>>())
    @Volatile var notMember = false
    /* Route 25 lists the family folder (false: deleted elsewhere, the family still listed). */
    @Volatile var areaListed = true
    /* Route 5 serves from version 1 whatever `after` asks (a server rolling back past what the phone holds). */
    @Volatile var ignoringAfter = false
    /* Route 2 lists the family (false: it stopped listing it); `groupsFail` and `rostersFail` answer with a 503. */
    @Volatile var listed = true
    @Volatile var groupsFail = false
    /* The next this many route 5 reads answer 503, then it serves again: a connection that drops for a moment. */
    @Volatile var rosterFailures = 0
    @Volatile var rostersFail = false
    @Volatile var groupState = "active"
    /* Maya's roles as route 2 lists them (`members` once Sam makes her a manager). */
    @Volatile var listedRoles: List<String> = emptyList()
    /* The member's self-grant as route 23 stored it, served back on route 25. */
    @Volatile var selfGrant: JSONObject? = null
    /* The node route 25 names as the area's top folder (a server's choice): the family's own unless a test names another. */
    @Volatile var servedRootId: String? = null
    /* Runs as route 5 is answered: another process at work meanwhile. */
    @Volatile var onRosters: (() -> Unit)? = null
    val asked = java.util.Collections.synchronizedList(ArrayList<String>())

    val summary get() = GroupSummary(groupId, "family", "Lindqvist family", emptyList(), groupState, chain.size.toLong(), 1L)

    /* Maya's pin over `rosters`, as joining on the web left it. */
    fun pin(rosters: List<SignedGroupStatement>, checkedAt: String = "2026-10-18T09:00:00.000Z"): GroupPin {
        val accepted: AcceptedRosters = (acceptRosters(groupId, groupPublicKey(groupSeed), GroupAnchor.CREATED, emptyList(), rosters, emptyList(), signerKeys,
            OwnIdentities(member.id.lowercase(), listOf(member.servedKeys())), null) as RosterChain.Accepted).chain
        return pinAfter(emptyList(), accepted, checkedAt)
    }

    /* The family's pin in the stored settings, as another device saved it. */
    fun storePin(pin: GroupPin) = server.editSettings { it.setGroupPin(groupId, pin) }

    private fun wire(signed: SignedGroupStatement) = JSONObject().put("statement", base64urlEncode(signed.statement))
        .put("signature", JSONObject().put("ed25519", base64urlEncode(signed.signature.ed25519)).put("mlDsa", base64urlEncode(signed.signature.mlDsa)))
        .put("signerSignature", base64urlEncode(signed.signerSignature))

    private fun identity(person: FakeDrive.Person) = JSONObject().put("userId", person.id.lowercase()).put("links", JSONArray()).put("identity", JSONObject()
        .put("keyVersion", person.keys.keyVersion.toLong()).put("encryptionPublicKey", person.keys.encryptionPublicKey).put("signingPublicKey", person.keys.signingPublicKey)
        .put("mlDsaPublicKey", person.keys.mlDsaPublicKey).put("kemPublicKey", person.keys.kemPublicKey))

    private fun notMemberAnswer() = 404 to JSONObject().put("code", "not-member").put("message", "You are not in this group.")

    private fun route(method: String, segments: List<String>, query: Map<String, String>, body: JSONObject): Pair<Int, JSONObject>? {
        val path = segments.joinToString("/")
        if (segments.firstOrNull() == "groups" || path == "drive/spaces" || segments.firstOrNull() == "invitations") asked.add("$method /$path")
        return when {
            method == "GET" && path == "groups" -> when {
                groupsFail -> 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
                !listed -> 200 to JSONObject().put("groups", JSONArray())
                else -> 200 to JSONObject().put("groups", JSONArray().put(JSONObject().put("id", groupId).put("kind", "family").put("name", "Lindqvist family")
                    .put("roles", JSONArray(listedRoles)).put("state", groupState).put("rosterVersion", chain.size).put("groupKeyVersion", 1)))
            }
            method == "GET" && path == "groups/$groupId" -> if (notMember) notMemberAnswer() else 200 to JSONObject()
                .put("head", JSONObject().put("version", chain.size).put("revision", chain.size)).put("members", JSONArray()
                .put(JSONObject().put("userId", creator.id).put("name", "Sam Lindqvist").put("email", "sam@example.org").put("state", "active").put("roles", JSONArray().put("billing").put("members")))
                .put(JSONObject().put("userId", member.id.lowercase()).put("name", "Maya").put("email", "me@example.org").put("state", "active").put("roles", JSONArray()))
                .apply { joined.forEach { person -> put(JSONObject().put("userId", person.id.lowercase()).put("name", nameOf(person)).put("email", emailOf(person)).put("state", "active").put("roles", JSONArray())) } })
            method == "GET" && path == "groups/$groupId/rosters" -> {
                if (notMember) return notMemberAnswer()
                if (rostersFail) return 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
                if (rosterFailures > 0) { rosterFailures--; return 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.") }
                onRosters?.invoke()
                val after = if (ignoringAfter) 0 else query["after"]?.toInt() ?: 0
                val served = chain
                200 to JSONObject().put("rosters", JSONArray(served.drop(after).map(::wire))).put("successions", JSONArray(successions.toList().map(::wire)))
                    .put("firstKeys", groupPublicKey(groupSeed).let { JSONObject().put("ed25519PublicKey", it.ed25519PublicKey).put("mlDsaPublicKey", it.mlDsaPublicKey) })
                    .put("signerKeys", JSONObject(signerKeys)).put("head", JSONObject().put("version", served.size).put("digest", rosterDigest(served.last().statement)))
                    .put("next", JSONObject.NULL)
            }
            method == "GET" && path == "groups/$groupId/identities" -> if (notMember) notMemberAnswer() else
                200 to JSONObject().put("identities", JSONArray().put(identity(creator)).put(identity(member)).apply { joined.forEach { put(identity(it)) } }).put("next", JSONObject.NULL)
            method == "PUT" && path == "groups/$groupId/areas/$workspaceId/self-grant" -> { selfGrant = body.getJSONObject("grant"); 200 to JSONObject() }
            method == "GET" && path == "groups/$groupId/key-seal" -> keySeal?.let { 200 to it }
                ?: (409 to JSONObject().put("code", "no-seal").put("message", "Nobody has sealed the current group key to you yet."))
            method == "POST" && path == "groups/$groupId/invitations" -> manageAnswer ?: (201 to JSONObject())
            method == "DELETE" && segments.size == 4 && path.startsWith("groups/$groupId/invitations/") -> manageAnswer
                ?: (200 to JSONObject()).also { invitationRows.removeIf { it.optString("id") == segments[3] } }
            method == "POST" && segments.size == 5 && path.startsWith("groups/$groupId/members/") && segments[4] == "decline" -> manageAnswer ?: (200 to JSONObject())
            method == "GET" && path == "groups/$groupId/invitations" -> invitationsAnswer
                ?: (200 to JSONObject().put("invitations", JSONArray((readBefore.get()?.also { readBefore.remove() } ?: invitationRows).toList())))
            method == "GET" && path == "groups/$groupId/pending" -> pendingAnswer ?: (200 to JSONObject().put("pending", JSONArray(pendingRows.toList())))
            method == "POST" && segments.size == 5 && path.startsWith("groups/$groupId/areas/") && segments[4] == "grants" -> {
                grantPosts.add(segments[3] to body.toString())
                grantsAnswer ?: (200 to JSONObject())
            }
            method == "POST" && segments.size == 5 && path.startsWith("groups/$groupId/members/") && segments[4] == "admit" -> {
                callBodies.add(body.toString())
                // A scripted answer first (another manager's win, a lost answer), else applied as the server would.
                admitAnswers.poll()?.invoke(body)?.let { return it }
                if (notMember) return notMemberAnswer()
                apply(body, segments[3])
            }
            method == "PATCH" && segments.size == 4 && path.startsWith("groups/$groupId/members/") -> {
                if (notMember) return notMemberAnswer()
                memberCalls.add(segments[3] to body.toString())
                memberAnswers.poll()?.invoke(body)?.let { return it }
                apply(body, null)
            }
            method == "POST" && path == "groups/$groupId/leave" -> {
                if (notMember) return notMemberAnswer()
                val ends = body.optJSONArray("endsLapsed")
                leaves.add((0 until (ends?.length() ?: 0)).map { ends!!.getString(it) })
                leaveRefusal?.let { return it }
                // Left: from now on the server answers not-member and lists the family nowhere.
                notMember = true
                listed = false
                200 to JSONObject().put("state", "left")
            }
            method == "GET" && path == "drive/spaces" -> 200 to JSONObject().put("spaces", JSONArray()
                .put(JSONObject().put("space", JSONObject().put("kind", "personal")).put("areas", JSONArray()))
                .apply {
                    if (!notMember) put(JSONObject().put("space", JSONObject().put("kind", "group").put("groupId", groupId).put("name", "Lindqvist family"))
                        .put("areas", JSONArray().apply {
                            if (areaListed) put(JSONObject().put("workspaceId", workspaceId).put("idSeed", area.seed).put("workspaceKeyVersion", areaVersion).put("changeSeq", 1)
                                .put("root", server.node(servedRootId ?: rootId).json())
                                .put("rotation", run?.takeIf { server.running(it.second) }?.let { (id, node, target) -> JSONObject().put("id", id).put("nodeId", node).put("targetEpoch", target) } ?: JSONObject.NULL)
                                .put("selfGrant", selfGrant?.takeIf { it.optLong("workspaceKeyVersion") == areaVersion } ?: JSONObject.NULL)
                                .put("grant", grantRow))
                        }))
                })
            else -> null
        }
    }

    /*
     * Sam changes the family folder's keys with the member list, as a removal does (groups-server 8, option A): roster 3
     * lists the folder at key version 2 with its top folder's new key, Maya gets a grant of version 2, and the top folder
     * is re-keyed at `target` under the new area key, its previous key wrapped under it too; everything below it is still
     * under the old keys, a key change from the top folder for any member to walk. The new chain.
     */
    fun replaceKeys(target: Long = 100L): List<SignedGroupStatement> {
        val held = chain
        val accepted = (acceptRosters(groupId, groupPublicKey(groupSeed), GroupAnchor.CREATED, emptyList(), held, emptyList(), signerKeys,
            OwnIdentities(creator.id, listOf(creator.servedKeys())), null) as RosterChain.Accepted).chain
        val newArea = randomBytes(32u)
        val newRoot = randomBytes(32u)
        val roster = rosterNext(accepted, accepted.roster().members, creator.id, listOf(AreaKey(workspaceId, newArea, newRoot)), null, null)
        val next = rosterSign(roster, groupSeed, creator.keys)
        val chain3 = (acceptRosters(groupId, groupPublicKey(groupSeed), GroupAnchor.CREATED, emptyList(), held + next, emptyList(), signerKeys,
            OwnIdentities(creator.id, listOf(creator.servedKeys())), null) as RosterChain.Accepted).chain
        val version = roster.rosterVersion.toLong()
        val envelope = areaGrantSeal(newArea, AreaGrantContext(groupId, workspaceId, 2uL, member.id.lowercase(), member.keys.keyVersion, creator.id, version.toULong(),
            rosterDigest(next.statement)), chain3, area.seed, base64urlDecode(member.keys.kemPublicKey!!), creator.keys)
        // The top folder at the new keys, its name sealed again and signed by Sam; the old key kept for its children.
        val node = server.node(rootId)
        server.keepPreviousKey(rootId)
        val oldKey = server.keyOf(rootId)
        val name = metadataOpen(MetadataContext(workspaceId, rootId, node.metadataVersion.toULong()), oldKey, base64urlDecode(node.metadataEnvelope))
        val sealed = metadataSeal(MetadataContext(workspaceId, rootId, node.metadataVersion.toULong()), newRoot, name)
        node.previous = Triple(base64urlEncode(previousRootKeyWrap(NodeKeyContext(workspaceId, rootId, workspaceId, 2uL, node.keyEpoch.toULong()), newArea, oldKey)), node.keyEpoch, 2L)
        node.keyEnvelope = base64urlEncode(nodeWrap(NodeKeyContext(workspaceId, rootId, workspaceId, 2uL, target.toULong()), newArea, newRoot))
        node.keyEpoch = target
        node.parentKeyEpoch = 2L
        node.metadataEnvelope = base64urlEncode(sealed)
        node.signature = base64urlEncode(metadataSign(creator.keys.signingSeed, MetadataStatement(workspaceId, rootId, NodeKind.FOLDER, node.metadataVersion.toULong()), sealed))
        node.signer = creator.id
        server.seedWorkspace(workspaceId, newArea, creator)
        server.touch(rootId)
        server.startRun(rootId, target)
        areaVersion = 2L
        grantRow = JSONObject().put("workspaceKeyVersion", 2).put("granteeKeyVersion", member.keys.keyVersion.toLong()).put("granterUserId", creator.id)
            .put("rosterVersion", version).put("rosterDigest", rosterDigest(next.statement)).put("envelope", base64urlEncode(envelope))
        run = Triple(UUID.randomUUID().toString(), rootId, target)
        chain = held + next
        return chain
    }

    /*
     * A roster call applied as the server applies it: refused as `stale` unless it was built at the head's revision, then
     * its roster appended to the chain and the person let in.
     */
    fun apply(body: JSONObject, userId: String?): Pair<Int, JSONObject> {
        val next = signedOf(body.getJSONObject("roster"))
        // A call the server took already, sent again (its answer was lost): answered with the head, as the server replays it.
        if (chain.any { it.statement.contentEquals(next.statement) })
            return 200 to JSONObject().put("head", JSONObject().put("version", chain.size).put("revision", chain.size))
        if (body.optLong("expectedRevision", -1) != chain.size.toLong())
            return 409 to JSONObject().put("code", "stale").put("message", "Another change to the family landed first.")
        val succession = body.optJSONObject("succession")?.let(::signedOf)
        // The roster (and its succession) must follow the head it names (the server's verify; `invalid`/`roster-chain` otherwise).
        if (runCatching { creatorChain(chain + next, successions.toList() + listOfNotNull(succession)) }.isFailure)
            return 400 to JSONObject().put("code", "invalid").put("message", "The change was refused.").put("data", JSONObject().put("reason", "roster-chain"))
        chain = chain + next
        succession?.let(successions::add)
        // The family's new key, sealed to Maya as a holder who stays: what route 8 serves her from now on.
        body.optJSONArray("seals")?.let { seals ->
            (0 until seals.length()).map(seals::getJSONObject).firstOrNull { it.optString("holderUserId").equals(member.id, ignoreCase = true) }?.let { seal ->
                keySeal = JSONObject(seal.toString()).put("sealerUserId", member.id.lowercase()).apply { remove("holderUserId") }
            }
        }
        if (userId == null) return 200 to JSONObject().put("head", JSONObject().put("version", chain.size).put("revision", chain.size))
        (listOf(server.grace) + server.others.values.map { it.first }).firstOrNull { it.id.equals(userId, ignoreCase = true) }?.let(joined::add)
        pendingRows.removeIf { it.optString("userId").equals(userId, ignoreCase = true) }
        return 200 to JSONObject().put("head", JSONObject().put("version", chain.size).put("revision", chain.size))
    }

    private fun signedOf(wire: JSONObject): SignedGroupStatement {
        val signature = wire.getJSONObject("signature")
        return SignedGroupStatement(base64urlDecode(wire.getString("statement")),
            GroupSignature(base64urlDecode(signature.getString("ed25519")), base64urlDecode(signature.getString("mlDsa"))),
            base64urlDecode(wire.getString("signerSignature")))
    }

    /* The chain as Sam's device accepted it: what his next roster is built over. */
    fun creatorChain(rosters: List<SignedGroupStatement> = chain, successions: List<SignedGroupStatement> = this.successions.toList()): AcceptedRosters =
        (acceptRosters(groupId, groupPublicKey(groupSeed), GroupAnchor.CREATED, emptyList(), rosters, successions, signerKeys,
            OwnIdentities(creator.id, listOf(creator.servedKeys())), null) as RosterChain.Accepted).chain

    /*
     * Sam makes Maya a manager (roster 3, after her admission at 2) and seals the family's key to her: what she needs to
     * let anyone in. The chain from there.
     */
    fun mayaManages(organizer: Boolean = false): List<SignedGroupStatement> {
        val accepted = creatorChain(listOf(r1, r2))
        // As organizer, Maya holds billing as well and Sam keeps managing: what she hands over.
        val members = accepted.roster().members.map {
            when {
                it.userId == member.id.lowercase() -> it.copy(roles = if (organizer) listOf(GroupRole.BILLING, GroupRole.MEMBERS) else listOf(GroupRole.MEMBERS))
                organizer -> it.copy(roles = listOf(GroupRole.MEMBERS))
                else -> it
            }
        }
        val r3m = rosterSign(rosterNext(accepted, members, creator.id, null, null, null), groupSeed, creator.keys)
        chain = listOf(r1, r2, r3m)
        listedRoles = if (organizer) listOf("billing", "members") else listOf("members")
        val head = creatorChain()
        val sealed = groupKeySeal(groupSeed, GroupKeySealContext(groupId, 1uL, member.id.lowercase(), member.keys.keyVersion, creator.id, 3uL,
            rosterDigest(r3m.statement)), head, base64urlDecode(member.keys.kemPublicKey!!), creator.keys)
        keySeal = JSONObject().put("groupKeyVersion", 1).put("holderKeyVersion", member.keys.keyVersion.toLong()).put("sealerUserId", creator.id)
            .put("rosterVersion", 3).put("rosterDigest", rosterDigest(r3m.statement)).put("envelope", base64urlEncode(sealed))
        return chain
    }

    /* Sam, on his own device, moves billing from `from` (Maya unless named) to `userId`: a handover another device made meanwhile. */
    fun samMovesBilling(userId: String, from: String = member.id) {
        val accepted = creatorChain()
        val members = accepted.roster().members.map {
            when {
                it.userId.equals(userId, ignoreCase = true) -> it.copy(roles = (it.roles + GroupRole.BILLING).distinct().sortedBy { role -> role.ordinal })
                it.userId.equals(from, ignoreCase = true) -> it.copy(roles = it.roles - GroupRole.BILLING)
                else -> it
            }
        }
        chain = chain + rosterSign(rosterNext(accepted, members, creator.id, null, null, null), groupSeed, creator.keys)
    }

    /* Sam, on his own device, gives `userId` billing: another manager's handover landing meanwhile. */
    fun samGivesBilling(userId: String) {
        val accepted = creatorChain()
        val members = accepted.roster().members.map {
            if (it.userId.equals(userId, ignoreCase = true)) it.copy(roles = (it.roles + GroupRole.BILLING).distinct().sortedBy { role -> role.ordinal }) else it
        }
        chain = chain + rosterSign(rosterNext(accepted, members, creator.id, null, null, null), groupSeed, creator.keys)
    }

    /* Sam changes the member list himself (a roster that only re-signs it): what another manager's win looks like. */
    fun samChangesTheList() {
        val accepted = creatorChain()
        chain = chain + rosterSign(rosterNext(accepted, accepted.roster().members, creator.id, null, null, null), groupSeed, creator.keys)
    }

    /* Maya's own words check of `person`: a verified pin of the keys HushOS serves for them now, in her settings. */
    fun verifyPin(person: FakeDrive.Person, email: String, name: String) =
        server.editSettings { it.pin(ContactPin.ofServed(person.id, email, name, person.served, "2026-11-03T00:00:00.000Z")!!) }

    /* `person` accepted an invitation and waits to be let in (route 16), with the identity HushOS serves for them now. */
    fun waiting(person: FakeDrive.Person, email: String, name: String) {
        pendingRows.add(JSONObject().put("userId", person.id.lowercase()).put("name", name).put("email", email).put("roles", JSONArray())
            .put("acceptedAt", "2026-11-02T10:00:00.000Z").put("identity", person.served.toJson()).put("inFamily", false))
    }

    /* Maya's phone: a vault signed in to the server, its sync over its own records folder (a relaunch passes the same one). */
    fun phone(records: File = File(RuntimeEnvironment.getApplication().cacheDir, "family-records-" + UUID.randomUUID())): Phone {
        val context: Context = RuntimeEnvironment.getApplication()
        val vault = Vault(context, DriveApi(Shared.session(context)!!))
        return Phone(vault, FamilySync(vault, GroupsApi(vault.api.session), FamilyRecords(records)), records)
    }

    class Phone(val vault: Vault, val sync: FamilySync, val folder: File) {
        val records get() = sync.records
    }

    companion object {
        /*
         * Route 18 is a PATCH, which Android's HttpURLConnection sends and the JVM's refuses: the test JVM is taught it
         * (its list of methods, opened by build.gradle.kts's --add-opens), so role changes run here as on a phone.
         */
        fun allowPatch() {
            val field = java.net.HttpURLConnection::class.java.getDeclaredField("methods").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST") val methods = field.get(null) as Array<String>
            if ("PATCH" !in methods) methods[methods.indexOf("TRACE")] = "PATCH"
        }

        /* The account signed in on this test's phone, as the other vault tests sign in. */
        fun signIn(server: FakeDrive, prefs: String) {
            val context: Context = RuntimeEnvironment.getApplication()
            Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }.set(null, context.getSharedPreferences(prefs, Context.MODE_PRIVATE))
            Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
            Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        }
    }
}
