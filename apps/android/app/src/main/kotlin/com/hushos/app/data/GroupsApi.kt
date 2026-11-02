package com.hushos.app.data

import com.hushos.core.GroupPublicKey
import com.hushos.core.GroupSignature
import com.hushos.core.ServedKeys
import com.hushos.core.SignedGroupStatement
import com.hushos.core.SuccessionLink
import com.hushos.core.WorkspaceGrant
import com.hushos.core.base64urlDecode
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/*
 * The group routes a member reads (docs/groups-server.md 4; iOS's GroupsAPI.swift, the web's lib/groups/api.ts): the
 * account's families (2), one family with its members (3), the member list a page at a time (5), every member's identity
 * and succession links (6), every space the account can open (25), the invitation opened and accepted (14, 15) and this
 * account's self-grant of a family folder (23). Nothing here is trusted until the core has accepted it (FamilySync).
 */

/*
 * A refusal with what decides it: the status, the server's code and its words. Status 0 is no answer at all (an unknown
 * outcome, never a refusal). Only 404 `not-member` lets a client wipe a family (groups-server 0.9).
 */
class GroupsApiError(
    val status: Int, val code: String?, message: String,
    /* The caller's own family an `in-family` refusal names (`data.family`). */
    val family: Invitation.Family? = null,
    /* `data.reason` and `data.invitee`. */
    val reason: String? = null, val invitee: Boolean = false,
    /* The plans an `ends-lapsed` refusal names (`data.plans`): they end at once when this person goes. */
    val plans: List<FamilyLapsedPlan> = emptyList(),
) : Exception(message) {
    val isNotMember: Boolean get() = status == 404 && code == "not-member"

    /* What the families screens say, as the web's errorCopy words it for a read. */
    val words: String get() = when {
        status == 0 -> NO_ANSWER
        code == "not-member" -> "You’re not in this family any more."
        code == "rate-limited" -> "That’s been tried too often. Wait a little, then try again."
        code == "unsupported" -> "Update HushOS to do this."
        status == 501 -> "Families aren’t available on this server."
        else -> "HushOS couldn’t do that just now. Try again in a moment."
    }

    companion object {
        const val NO_ANSWER = "Couldn’t reach HushOS. Check your connection, then retry."

        fun refusal(status: Int, text: String): GroupsApiError {
            val body = runCatching { JSONObject(text) }.getOrNull()
            val data = body?.optJSONObject("data")
            val family = data?.optJSONObject("family")?.let { f ->
                val id = f.optString("groupId").ifEmpty { null }
                val name = f.optString("name").ifEmpty { null }
                if (id != null && name != null) Invitation.Family(id, name) else null
            }
            return GroupsApiError(status, body?.optString("code")?.ifEmpty { null }, body?.optString("message")?.ifEmpty { null } ?: "Please try again.",
                family, data?.optString("reason")?.ifEmpty { null }, data?.optBoolean("invitee") == true, FamilyLapsedPlan.listIn(data))
        }
    }
}

/* A family plan someone pays for that gives nothing now (the web's LapsedPlanNamed): unpaid, or paused. */
data class FamilyLapsedPlan(val id: String, val name: String, val paused: Boolean) {
    companion object {
        /* `data.plans` of an `ends-lapsed` refusal, each with an id and a name (the web's lapsedPlansIn). */
        fun listIn(data: JSONObject?): List<FamilyLapsedPlan> = data?.optJSONArray("plans").objects().mapNotNull { plan ->
            val id = plan.optString("id").ifEmpty { return@mapNotNull null }
            val name = plan.optString("name").ifEmpty { return@mapNotNull null }
            FamilyLapsedPlan(id, name, plan.optString("standing") == "paused")
        }

        /*
         * What ends when the person who pays for these plans leaves, every plan named (the web's lapsedEndsWords, the
         * leaver's own case).
         */
        fun endsWhenYouLeave(family: String, plans: List<FamilyLapsedPlan>): String {
            val several = plans.size > 1
            val names = plans.joinToString(" and ") { word(it.name) } + if (several) " plans" else " plan"
            val how = if (several) "which give nothing now" else if (plans.firstOrNull()?.paused == true) "which is paused" else "whose payment didn’t go through"
            val after = if (several) "Nothing of them is refunded: no part of them is in use." else "Nothing of it is refunded: no part of it is in use."
            return "The $names for $family, which you pay for and $how, ${if (several) "end" else "ends"} at once when you leave. $after"
        }

        /* "Family Pro (monthly)" is "Family Pro"; "Family plan" is "Family", as "…’s Family plan". */
        private fun word(productName: String) =
            productName.replace(Regex("\\s*\\((monthly|yearly|annual)\\)\\s*$", RegexOption.IGNORE_CASE), "").replace(Regex("\\s+plan$", RegexOption.IGNORE_CASE), "")
    }
}

/* Route 14's answer: an invitation as the server describes it to the signed-in invitee. */
data class Invitation(
    /* The invitee's own family (one per account): they leave it before they can accept. */
    val inFamily: Family?, val invitationId: String, val groupId: String, val kind: String, val name: String,
    val inviter: Inviter?, val expiresAt: String,
) {
    data class Family(val groupId: String, val name: String)
    data class Inviter(val id: String, val name: String, val email: String?)

    companion object {
        fun from(json: JSONObject) = Invitation(
            json.optJSONObject("inFamily")?.let { Family(it.getString("groupId"), it.getString("name")) },
            json.getString("invitationId"), json.getString("groupId"), json.getString("kind"), json.getString("name"),
            json.optJSONObject("inviter")?.let { Inviter(it.getString("id"), it.getString("name"), if (it.isNull("email")) null else it.optString("email").ifEmpty { null }) },
            json.getString("expiresAt"),
        )
    }
}

/* Route 2's row: one family this account accepted an invitation to (`accepted`, waiting to be let in) or is in (`active`). */
data class GroupSummary(val id: String, val kind: String, val name: String, val roles: List<String>, val state: String, val rosterVersion: Long, val groupKeyVersion: Long) {
    companion object {
        fun from(json: JSONObject) = GroupSummary(
            json.getString("id"), json.getString("kind"), json.getString("name"), json.optJSONArray("roles").strings(), json.getString("state"),
            json.optLong("rosterVersion"), json.optLong("groupKeyVersion"),
        )
    }
}

/*
 * Route 3: the family's members as the server names them (rosters carry no names), and the head's revision a roster call
 * is built against (0 when the server sent none).
 */
data class GroupDetail(val members: List<Member>, val revision: Long = 0L) {
    data class Member(val userId: String, val name: String, val email: String?, val state: String, val roles: List<String>)

    companion object {
        fun from(json: JSONObject) = GroupDetail(json.getJSONArray("members").objects().map {
            Member(it.getString("userId"), it.optString("name"), if (it.isNull("email")) null else it.optString("email").ifEmpty { null },
                it.getString("state"), it.optJSONArray("roles").strings())
        }, json.optJSONObject("head")?.optLong("revision") ?: 0L)
    }
}

/* Route 16's row: someone who accepted an invitation, waiting to be let in, with their identity as HushOS serves it now. */
data class PendingPerson(val userId: String, val name: String, val email: String, val identity: com.hushos.core.PublicIdentity?, val inFamily: Boolean) {
    companion object {
        fun from(json: JSONObject) = PendingPerson(json.getString("userId"), json.optString("name"), json.optString("email"),
            json.optJSONObject("identity")?.let { runCatching {
                com.hushos.core.PublicIdentity(it.getLong("keyVersion").toULong(), it.getString("encryptionPublicKey"), it.getString("signingPublicKey"),
                    it.getString("mlDsaPublicKey"), it.getString("kemPublicKey"), it.getString("keysSignature"))
            }.getOrNull() }, json.optBoolean("inFamily"))
    }
}

/* Route 12's row: an invitation still open. */
data class OpenInvitation(val id: String, val email: String?, val invitedBy: String?, val expiresAt: String) {
    companion object {
        fun from(json: JSONObject) = OpenInvitation(json.getString("id"), json.optString("email").ifEmpty { null },
            json.optString("invitedBy").ifEmpty { null }, json.optString("expiresAt"))
    }
}

/*
 * A roster call's answer as the outbox reads it (the core's outbox_step): the status (0 for no answer at all), the
 * refusal's code and its data, and the server's sentence.
 */
data class CallAnswer(val status: Int, val code: String?, val data: JSONObject?, val message: String?)

/* Route 5's page. */
class RosterPage(val rosters: List<SignedGroupStatement>, val successions: List<SignedGroupStatement>, val firstKeys: GroupPublicKey,
                 val signerKeys: Map<String, String>, val next: Int?) {
    companion object {
        private fun signed(json: JSONObject): SignedGroupStatement {
            val signature = json.getJSONObject("signature")
            return SignedGroupStatement(base64urlDecode(json.getString("statement")),
                GroupSignature(base64urlDecode(signature.getString("ed25519")), base64urlDecode(signature.getString("mlDsa"))),
                base64urlDecode(json.getString("signerSignature")))
        }

        fun from(json: JSONObject): RosterPage {
            val first = json.getJSONObject("firstKeys")
            val signers = json.optJSONObject("signerKeys") ?: JSONObject()
            return RosterPage(json.getJSONArray("rosters").objects().map(::signed), json.optJSONArray("successions").objects().map(::signed),
                GroupPublicKey(first.getString("ed25519PublicKey"), first.getString("mlDsaPublicKey")),
                signers.keys().asSequence().associateWith { signers.getString(it) },
                if (json.isNull("next")) null else json.optInt("next"))
        }
    }
}

/* Route 6's row: a member's current identity (none for an account that is gone) and their succession links. */
class MemberIdentity(val userId: String, val identity: ServedKeys?, val links: List<SuccessionLink>) {
    companion object {
        fun from(json: JSONObject) = MemberIdentity(
            json.getString("userId"),
            json.optJSONObject("identity")?.let { ServedKeys(it.getLong("keyVersion").toULong(), it.getString("encryptionPublicKey"), it.getString("signingPublicKey"),
                it.getString("mlDsaPublicKey"), it.getString("kemPublicKey")) },
            json.optJSONArray("links").objects().map {
                SuccessionLink(it.getLong("oldKeyVersion").toULong(), it.getLong("newKeyVersion").toULong(), it.getString("oldEncryptionPublicKey"),
                    it.getString("oldSigningPublicKey"), it.getString("oldMlDsaPublicKey"), it.getString("newEncryptionPublicKey"), it.getString("newSigningPublicKey"),
                    it.getString("newMlDsaPublicKey"), it.getString("newKemPublicKey"), it.getString("signature"), if (it.isNull("consent")) null else it.optString("consent").ifEmpty { null })
            },
        )
    }
}

/*
 * A key change running in a family folder, as route 25 names it: the run's id (absent on older servers), the node it
 * re-keys from and the key epoch it moves everything to (the web's WalkTarget, less the workspace).
 */
data class SpaceRotation(val id: String?, val nodeId: String, val targetEpoch: ULong) {
    companion object {
        /* Null for none, and for one whose fields don't read: a run nobody can name is walked by nobody. */
        fun from(json: JSONObject?): SpaceRotation? {
            json ?: return null
            val nodeId = json.optString("nodeId").ifEmpty { return null }
            val target = json.optLong("targetEpoch", -1L).takeIf { it > 0 } ?: return null
            return SpaceRotation(if (json.isNull("id")) null else json.optString("id").ifEmpty { null }, nodeId, target.toULong())
        }
    }
}

/* Route 25: one family's areas (the personal space is never read from here). */
class SpaceArea(
    val workspaceId: String, val idSeed: String?, val workspaceKeyVersion: ULong, val root: NodeView?, val rotation: SpaceRotation?,
    val grant: AreaGrantRow?, val selfGrant: WorkspaceGrant?,
) {
    val rotating: Boolean get() = rotation != null

    class AreaGrantRow(val workspaceKeyVersion: ULong, val granteeKeyVersion: ULong, val granterUserId: String, val rosterVersion: ULong, val rosterDigest: String, val envelope: String)

    companion object {
        fun from(json: JSONObject) = SpaceArea(
            json.getString("workspaceId"), if (json.isNull("idSeed")) null else json.optString("idSeed").ifEmpty { null },
            json.getLong("workspaceKeyVersion").toULong(), json.optJSONObject("root")?.let(NodeView::from),
            // A run present but unreadable still says the folder is changing keys; only a readable one is walked.
            SpaceRotation.from(json.optJSONObject("rotation")) ?: json.optJSONObject("rotation")?.let { SpaceRotation(null, "", 0uL) },
            json.optJSONObject("grant")?.let { AreaGrantRow(it.getLong("workspaceKeyVersion").toULong(), it.getLong("granteeKeyVersion").toULong(),
                it.getString("granterUserId"), it.getLong("rosterVersion").toULong(), it.getString("rosterDigest"), it.getString("envelope")) },
            // One that doesn't decode is none: the ledger ignores a bad self-grant anyway, and it must not stop the list loading.
            json.optJSONObject("selfGrant")?.let { runCatching { GrantView(it).grant }.getOrNull() },
        )
    }
}

class GroupsApi(private val session: Shared.Session) {
    private val cookie = (if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session") + "=" + session.token

    /* A family id goes into a path only as a lowercase UUID. */
    private fun id(groupId: String): String {
        if (!FamilyRecords.valid(groupId)) throw GroupsApiError(400, "invalid", "Please try again.")
        return groupId
    }

    private fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        val status: Int
        val text: String
        try {
            val connection = URL(session.origin + "/api" + path).openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.setRequestProperty("Cookie", cookie)
            connection.setRequestProperty("Origin", session.origin)
            connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw GroupsApiError(0, null, GroupsApiError.NO_ANSWER)
        }
        if (status == 401) throw NotAuthenticated()
        if (status !in 200..299) throw GroupsApiError.refusal(status, text)
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    /*
     * 14: what the mailed invitation is, for this account. The token goes in the body, never a path or query, so it
     * reaches no log; one that isn't a token is refused here as the server would (410 `gone`).
     */
    fun openInvitation(token: String): Invitation {
        if (!AppLinks.isToken(token)) throw GroupsApiError(410, "gone", "This invitation is no longer open.")
        return Invitation.from(call("/invitations/open", "POST", JSONObject().put("token", token)))
    }

    /* 15: the invitation bound to this account; lets nobody in. The family's id. */
    fun acceptInvitation(token: String): String {
        if (!AppLinks.isToken(token)) throw GroupsApiError(410, "gone", "This invitation is no longer open.")
        val groupId = call("/invitations/accept", "POST", JSONObject().put("token", token)).getString("groupId").lowercase()
        return id(groupId)
    }

    /* 2 */
    fun listGroups(): List<GroupSummary> = call("/groups").getJSONArray("groups").objects().map(GroupSummary::from)

    /* 3 */
    fun group(groupId: String): GroupDetail = GroupDetail.from(call("/groups/${id(groupId)}"))

    /* 5: the rosters after `after` (none: from version 1). */
    fun rosters(groupId: String, after: Int): RosterPage = RosterPage.from(call("/groups/${id(groupId)}/rosters" + if (after > 0) "?after=$after" else ""))

    /* 6, one page. */
    fun identities(groupId: String, after: String?): Pair<List<MemberIdentity>, String?> {
        val page = call("/groups/${id(groupId)}/identities" + (after?.let { "?after=" + URLEncoder.encode(it, "UTF-8") } ?: ""))
        return page.getJSONArray("identities").objects().map(MemberIdentity::from) to (if (page.isNull("next")) null else page.optString("next").ifEmpty { null })
    }

    /* 25: the areas of every family this account can open, by lowercase family id. */
    fun spaces(): Map<String, List<SpaceArea>> {
        val out = HashMap<String, List<SpaceArea>>()
        for (entry in call("/drive/spaces").getJSONArray("spaces").objects()) {
            val space = entry.getJSONObject("space")
            if (space.optString("kind") != "group") continue
            val groupId = space.optString("groupId").lowercase().ifEmpty { continue }
            out[groupId] = entry.getJSONArray("areas").objects().map(SpaceArea::from)
        }
        return out
    }

    /*
     * 20: leaving at once. `endsLapsed` names the lapsed plans this person pays for that they confirmed end (ids, as an
     * `ends-lapsed` refusal named them). Whether the family ended with them (they were its last member).
     */
    fun leave(groupId: String, endsLapsed: List<String> = emptyList()): Boolean =
        call("/groups/${id(groupId)}/leave", "POST", JSONObject().put("endsLapsed", JSONArray(endsLapsed))).optBoolean("dissolved")

    /* 8: the family's current group key, sealed to this account by a holder. */
    fun keySeal(groupId: String): com.hushos.core.ServedKeySeal = call("/groups/${id(groupId)}/key-seal").let {
        com.hushos.core.ServedKeySeal(it.getLong("groupKeyVersion").toULong(), it.getLong("holderKeyVersion").toULong(), it.getString("sealerUserId"),
            it.getLong("rosterVersion").toULong(), it.getString("rosterDigest"), base64urlDecode(it.getString("envelope")))
    }

    /* 11: an invitation by email; roles none (a role is given once they're in). */
    fun invite(groupId: String, email: String) {
        call("/groups/${id(groupId)}/invitations", "POST", JSONObject().put("email", email).put("roles", JSONArray()))
    }

    /* 12 */
    fun invitations(groupId: String): List<OpenInvitation> =
        call("/groups/${id(groupId)}/invitations").optJSONArray("invitations").objects().map(OpenInvitation::from)

    /* 13 */
    fun revokeInvitation(groupId: String, invitationId: String) {
        if (!FamilyRecords.valid(invitationId.lowercase())) throw GroupsApiError(410, "gone", "This invitation is no longer open.")
        call("/groups/${id(groupId)}/invitations/${invitationId.lowercase()}", "DELETE", JSONObject())
    }

    /* 16 */
    fun pending(groupId: String): List<PendingPerson> =
        call("/groups/${id(groupId)}/pending").optJSONArray("pending").objects().map(PendingPerson::from).filter { FamilyRecords.valid(it.userId.lowercase()) }

    /* 26: Not now on someone waiting. */
    fun decline(groupId: String, userId: String) {
        call("/groups/${id(groupId)}/members/${id(userId.lowercase())}/decline", "POST", JSONObject())
    }

    /*
     * A roster call sent as it was signed, byte for byte (17, admit; 18, member), answered for the outbox: never thrown
     * for a refusal or no answer (the outbox decides), only for a lost session.
     */
    fun sendCall(groupId: String, route: com.hushos.core.ChainRoute, body: String): CallAnswer {
        val path = when (route) {
            is com.hushos.core.ChainRoute.Admit -> "/groups/${id(groupId)}/members/${id(route.userId.lowercase())}/admit" to "POST"
            is com.hushos.core.ChainRoute.Member -> "/groups/${id(groupId)}/members/${id(route.userId.lowercase())}" to "PATCH"
            else -> return CallAnswer(400, "unsupported", null, "Update HushOS to do this.")
        }
        return raw(path.first, path.second, body)
    }

    /* 22: grants a call met as `grants-due`, one folder's at a time, as the core sealed them. */
    fun postGrants(groupId: String, workspaceId: String, body: String): CallAnswer {
        if (!FamilyRecords.valid(workspaceId.lowercase())) return CallAnswer(400, "invalid", null, "Please try again.")
        return raw("/groups/${id(groupId)}/areas/${workspaceId.lowercase()}/grants", "POST", body)
    }

    private fun raw(path: String, method: String, body: String): CallAnswer {
        val status: Int
        val text: String
        try {
            val connection = URL(session.origin + "/api" + path).openConnection() as HttpURLConnection
            // Android's HttpURLConnection takes PATCH (DriveApi.updateLink sends one too).
            connection.requestMethod = method
            connection.setRequestProperty("Cookie", cookie)
            connection.setRequestProperty("Origin", session.origin)
            connection.setRequestProperty("HushOS-Client", CLIENT_HEADER)
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray()) }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (_: java.io.IOException) {
            return CallAnswer(0, null, null, GroupsApiError.NO_ANSWER)
        }
        if (status == 401) throw NotAuthenticated()
        val json = runCatching { JSONObject(text) }.getOrNull()
        return CallAnswer(status, json?.optString("code")?.ifEmpty { null }, json?.optJSONObject("data"), json?.optString("message")?.ifEmpty { null })
    }

    /* 23: this account's self-grant of a family folder's current key, as the ledger wrapped it. */
    fun putSelfGrant(groupId: String, workspaceId: String, grant: WorkspaceGrant) {
        if (!FamilyRecords.valid(workspaceId)) throw GroupsApiError(400, "invalid", "Please try again.")
        call("/groups/${id(groupId)}/areas/$workspaceId/self-grant", "PUT", JSONObject().put("grant", JSONObject().put("version", grant.version.toInt())
            .put("workspaceId", grant.workspaceId).put("keyVersion", grant.keyVersion.toLong()).put("workspaceKeyVersion", grant.workspaceKeyVersion.toLong())
            .put("wrappingSalt", grant.wrappingSalt).put("wrappingNonce", grant.wrappingNonce).put("encryptedKey", grant.encryptedKey)))
    }
}

private fun JSONArray?.objects(): List<JSONObject> = this?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()

private fun JSONArray?.strings(): List<String> = this?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } }.orEmpty()
