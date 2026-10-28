package com.hushos.app.data

import com.hushos.core.NodeMetadata
import com.hushos.core.deriveId
import com.hushos.core.identityCreate
import com.hushos.core.randomBytes
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertNotEquals
import org.junit.Test

/*
 * Ids derived from a seed and a scope (docs/integrity-design.md): every create sends each id beside the seed it came
 * from, under the field names the server reads, and the seed derives that id for the workspace the request names. The
 * server answers anything else with 400 "This id was not made for this workspace", so each check here is a create
 * that would be refused.
 */
class ScopedIdsTest {
    private val ws = "600e9d40-c3b4-49bd-8e63-9bd7b3f63dbc"
    private val elsewhere = "7d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6"

    @Test
    fun eachKindTravelsWithItsSeedUnderTheServersFieldNames() {
        val expected = mapOf(
            IdField.NODE to ("id" to "idSeed"),
            IdField.VERSION to ("versionId" to "versionIdSeed"),
            IdField.OBJECT to ("objectId" to "objectIdSeed"),
            IdField.LINK to ("linkId" to "linkIdSeed"),
            IdField.REPORT to ("id" to "reportIdSeed"),
        )
        for ((field, names) in expected) {
            val made = field.mint(ws)
            val body = JSONObject().putId(made)
            assertEquals(setOf(names.first, names.second), body.keys().asSequence().toSet())
            // The seed sent derives the id sent, for this kind in this workspace, and for nothing else.
            assertEquals(body.getString(names.first), deriveId(field.kind, ws, body.getString(names.second)))
            assertNotEquals(made.id, deriveId(field.kind, elsewhere, made.seed))
        }
    }

    @Test
    fun anUploadsThreeIdsAreEachMintedForTheirOwnKind() {
        // One begin body carries a node, a version and an object id: a seed swapped between them, or one kind minted
        // for another, derives a different id and the upload is refused.
        val node = JSONObject().putId(IdField.NODE.mint(ws))
        val body = JSONObject().put("node", node).putId(IdField.VERSION.mint(ws)).putId(IdField.OBJECT.mint(ws))
        assertEquals(node.getString("id"), deriveId(IdField.NODE.kind, ws, node.getString("idSeed")))
        assertEquals(body.getString("versionId"), deriveId(IdField.VERSION.kind, ws, body.getString("versionIdSeed")))
        assertEquals(body.getString("objectId"), deriveId(IdField.OBJECT.kind, ws, body.getString("objectIdSeed")))
        assertNotEquals(body.getString("versionId"), deriveId(IdField.OBJECT.kind, ws, body.getString("versionIdSeed")))
    }

    @Test
    fun aReportIsMintedInTheReportedItemsWorkspace() {
        // A visitor or grantee reports someone else's item: the id is scoped to that item's workspace, not to anything
        // of the reporter's, since that is the workspace the server derives it for.
        val operatorId = "55555555-5555-4555-8555-555555555555"
        val envelope = identityCreate(operatorId, randomBytes(32u), 1uL)
        val operator = ReportOperator(operatorId, WebFixture.served(envelope))
        val node = NodeView("dc94437c-d237-4f94-bef8-9caeb51bea5e", elsewhere, "parent", "file", 2uL, 1uL, "k", 1uL, "m", null, null, null, null)
        val body = Reports.body(listOf(operator), Opened(node, NodeMetadata("a.txt", null, null, null, emptyMap())), randomBytes(32u), "other", "", null, JSONObject().put("link", "t"))
        assertEquals(elsewhere, body.getString("workspaceId"))
        assertEquals(body.getString("id"), deriveId(IdField.REPORT.kind, elsewhere, body.getString("reportIdSeed")))
    }

    @Test
    fun aVersionTwoOperatorIsSealedToOnlyOnceItsKeysStatementHolds() {
        // The served identity reaches the core whole: an ML-KEM key the operator's keys statement does not name (a
        // server swapping in its own) is refused, where dropping the statement on the way would seal to it unchecked.
        val operatorId = "55555555-5555-4555-8555-555555555555"
        val served = WebFixture.served(identityCreate(operatorId, randomBytes(32u), 1uL))
        val other = identityCreate(operatorId, randomBytes(32u), 1uL).kem!!.publicKey
        val node = NodeView("dc94437c-d237-4f94-bef8-9caeb51bea5e", elsewhere, "parent", "file", 2uL, 1uL, "k", 1uL, "m", null, null, null, null)
        fun report(identity: ServedIdentity) = Reports.body(listOf(ReportOperator(operatorId, identity)), Opened(node, NodeMetadata("a.txt", null, null, null, emptyMap())),
            randomBytes(32u), "other", "", null, JSONObject().put("link", "t"))
        report(served)
        assertThrows(Exception::class.java) { report(served.copy(kemPublicKey = other)) }
        // An operator with no ML-KEM key is refused rather than sealed to X25519 alone.
        assertThrows(Exception::class.java) { report(ServedIdentity(1uL, served.encryptionPublicKey, served.signingPublicKey, null, null, 1, null)) }
    }
}
