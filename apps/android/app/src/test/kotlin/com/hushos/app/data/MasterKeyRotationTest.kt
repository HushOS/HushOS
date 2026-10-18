package com.hushos.app.data

import com.hushos.core.WorkspaceGrant
import com.hushos.core.areaSelfGrantRewrap
import com.hushos.core.base64urlDecode
import com.hushos.core.randomBytes
import com.hushos.core.workspaceOpen
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/*
 * A master-key rotation's grants, as the challenge serves them (`Auth.rewrapGrants`, the step of `rotateKeys` after
 * the OPAQUE exchange). The web's own grants: its personal grant and a family folder's self-grant, both under one
 * account key. The self-grant must be rewrapped as its family's; read as a personal grant it does not open, and the
 * rotation must be refused.
 */
class MasterKeyRotationTest {
    private val area = WebFixture.json.getJSONObject("areaSelfGrant")
    private val workspace = WebFixture.json.getJSONObject("workspace")
    private val userId = area.getString("userId")
    private val groupId = area.getString("groupId")
    private val oldRoot = base64urlDecode(area.getString("accountKey"))

    /* The challenge's rows: the personal grant (no family) and the self-grant, its family under `key`. */
    private fun served(key: String = "groupId", family: Any = groupId) = JSONArray()
        .put(JSONObject(workspace.getJSONObject("grant").toString()).put("groupId", JSONObject.NULL))
        .put(JSONObject(area.getJSONObject("grant").toString()).put(key, family))

    private fun grant(g: JSONObject) = WorkspaceGrant(g.getInt("version").toUInt(), g.getString("workspaceId"), g.getLong("keyVersion").toULong(),
        g.getLong("workspaceKeyVersion").toULong(), g.getString("wrappingSalt"), g.getString("wrappingNonce"), g.getString("encryptedKey"))

    @Test
    fun aFamilyRowIsRewrappedUnderItsFamilyAndThePersonalOneAsPersonal() {
        val newRoot = randomBytes(32u)
        val rewrapped = Auth.rewrapGrants(served(), userId, oldRoot, newRoot, 3uL)
        val personal = grant(rewrapped.getJSONObject(0))
        val family = grant(rewrapped.getJSONObject(1))
        assertEquals(listOf(3uL, 3uL), listOf(personal.keyVersion, family.keyVersion))
        assertArrayEquals(base64urlDecode(workspace.getString("workspaceKey")), workspaceOpen(userId, newRoot, personal))
        // Bound to the family under the new root: the personal opener refuses it, and only a rewrap as the family's
        // (which opens it first) takes it on.
        assertThrows(Exception::class.java) { workspaceOpen(userId, newRoot, family) }
        assertEquals(family.workspaceKeyVersion, areaSelfGrantRewrap(userId, groupId, newRoot, randomBytes(32u), family, 4uL).workspaceKeyVersion)
        assertThrows(Exception::class.java) { areaSelfGrantRewrap(userId, groupId, oldRoot, randomBytes(32u), family, 4uL) }
    }

    @Test
    fun aSelfGrantServedWithoutItsFamilyOrWithAnotherIsRefused() {
        val newRoot = randomBytes(32u)
        // A misspelled key reads as no family: the personal path, which cannot open it.
        assertThrows(Exception::class.java) { Auth.rewrapGrants(served(key = "groupID"), userId, oldRoot, newRoot, 3uL) }
        assertThrows(Exception::class.java) { Auth.rewrapGrants(served(family = JSONObject.NULL), userId, oldRoot, newRoot, 3uL) }
        assertThrows(Exception::class.java) {
            Auth.rewrapGrants(served(family = "44444444-4444-4444-8444-444444444444"), userId, oldRoot, newRoot, 3uL)
        }
    }
}
