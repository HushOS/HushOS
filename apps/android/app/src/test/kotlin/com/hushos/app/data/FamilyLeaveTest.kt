package com.hushos.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/*
 * Leaving a family (Android 4; the web's LeaveDialog and wipeGroup) through the real Vault, GroupsApi and the core's area
 * ledger against FakeDrive: a leave the server takes wipes what this phone kept of the family and keeps the marks that make
 * its return no first use; a leave it refuses keeps everything.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyLeaveTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-leave-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* A phone that accepted the family, listed its folder, opened Sam's file into the family's copies and kept its thumbnail. */
    private fun opened(): Triple<FamilyFixture.Phone, File, String> {
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        val file = phone.vault.listChildren(family.rootId, family.workspaceId).single { it.id == family.fileId }
        val copy = File(FamilyCopies.folder(app.cacheDir, family.workspaceId), "${file.id}/Recipes.txt").apply { parentFile!!.mkdirs() }
        phone.vault.download(file.id, copy, workspaceId = family.workspaceId)
        assertEquals("marker-family", copy.readText())
        val versionId = file.node.currentVersion!!.id
        phone.vault.mirror.putThumbnail(versionId, byteArrayOf(1, 2, 3))
        return Triple(phone, copy, versionId)
    }

    /*
     * Leave lands: the family's keys (the ledger holds none of its folders), its device record, its rows, its opened copies
     * and the sealed thumbnail kept of its file go; the settings pin and the family guard stay, so the family coming back
     * is never first use, and route 2 no longer has it asked about. Fails if the leave keeps any of the first, or wipes
     * either mark.
     */
    @Test
    fun leavingWipesKeysRecordAndCopiesAndKeepsTheSettingsPin() {
        val (phone, copy, versionId) = opened()
        val pinBefore = server.settings().groupPin(family.groupId)
        assertNotNull(pinBefore)
        val left = phone.sync.leave(family.groupId)
        assertTrue("$left", left is FamilySync.Leaving.Left)
        assertEquals(FamilyState.Wiped, (left as FamilySync.Leaving.Left).removed.state)
        assertEquals(listOf(emptyList<String>()), family.leaves)
        // Keys: nothing of the family opens through this phone's ledger.
        assertFalse(phone.vault.areaLedger.isArea(family.workspaceId))
        assertNull(phone.vault.areaLedger.nodeKey(family.workspaceId, family.rootId))
        assertNull(phone.vault.areaLedger.nodeKey(family.workspaceId, family.fileId))
        // Record, rows, copies, thumbnail.
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertNull(phone.vault.item(family.workspaceId, family.fileId))
        assertNull(phone.vault.item(family.workspaceId, family.rootId))
        assertFalse(copy.exists())
        assertFalse(FamilyCopies.folder(app.cacheDir, family.workspaceId)!!.exists())
        assertNull(phone.vault.mirror.thumbnail(versionId))
        // The marks stay: the settings pin as it was, and the family guard.
        assertEquals(pinBefore, server.settings().groupPin(family.groupId))
        assertNotNull(phone.vault.familyGuard.family(family.groupId))
        // Route 2 no longer lists it, and nothing of it is asked about again.
        family.asked.clear()
        val (listed, gone) = phone.sync.listReconciling()
        assertTrue(listed.isEmpty() && gone.isEmpty())
        assertFalse(family.asked.any { it.startsWith("GET /groups/${family.groupId}") })
    }

    /*
     * The organizer and the last manager can't leave: the server refuses, said in the web's words, and everything the
     * phone kept stays (keys, record, rows, copies). So does a leave that would end a lapsed plan this person pays for,
     * until they confirm it by id. Fails if a refusal wipes anything, or the words aren't the web's.
     */
    @Test
    fun theOrganizersAndLastManagersRefusalsKeepEverything() {
        val (phone, copy, _) = opened()
        for ((code, words) in listOf("organizer" to "Make someone else the organizer first.", "last-holder" to "Let someone else manage the family first.")) {
            family.leaveRefusal = 409 to JSONObject().put("code", code).put("message", "Hand the group’s billing to another member before you leave.")
            assertEquals(FamilySync.Leaving.Refused(words), phone.sync.leave(family.groupId))
            assertTrue(phone.vault.areaLedger.isArea(family.workspaceId))
            assertNotNull(phone.records.read(family.member.id, family.groupId))
            assertNotNull(phone.vault.item(family.workspaceId, family.fileId))
            assertTrue(copy.exists())
        }
        family.leaveRefusal = 409 to JSONObject().put("code", "ends-lapsed").put("message", "You pay for the family’s Family plan, which gives nothing now.")
            .put("data", JSONObject().put("plans", JSONArray().put(JSONObject().put("id", "sub_1").put("name", "Family Pro (monthly)").put("standing", "paused"))))
        val asked = phone.sync.leave(family.groupId)
        assertEquals(FamilySync.Leaving.EndsLapsed(listOf(FamilyLapsedPlan("sub_1", "Family Pro (monthly)", true))), asked)
        assertEquals(
            "The Family Pro plan for Lindqvist family, which you pay for and which is paused, ends at once when you leave. Nothing of it is refunded: no part of it is in use.",
            FamilyLapsedPlan.endsWhenYouLeave("Lindqvist family", (asked as FamilySync.Leaving.EndsLapsed).plans),
        )
        assertTrue(phone.vault.areaLedger.isArea(family.workspaceId))
        assertTrue(copy.exists())
        // Confirmed: the next leave names the plan, and lands.
        family.leaveRefusal = null
        assertTrue(phone.sync.leave(family.groupId, asked.plans.map { it.id }) is FamilySync.Leaving.Left)
        assertEquals(listOf("sub_1"), family.leaves.last())
        assertFalse(copy.exists())
    }

    /* Leave family is offered unless the member list already shows the server would refuse it; the last one may always leave. */
    @Test
    fun leaveIsOfferedUnlessTheMemberListShowsItWouldBeRefused() {
        fun member(id: String, vararg roles: String) = GroupDetail.Member(id, id, null, "active", roles.toList())
        assertEquals(FamilySync.ORGANIZER_FIRST, FamilySync.leaveBlocker("me", listOf(member("me", "billing", "members"), member("sam", "members"))))
        assertEquals(FamilySync.MANAGER_FIRST, FamilySync.leaveBlocker("me", listOf(member("me", "members"), member("sam", "billing"))))
        assertNull(FamilySync.leaveBlocker("me", listOf(member("me", "billing", "members"), member("sam", "billing", "members"))))
        assertNull(FamilySync.leaveBlocker("me", listOf(member("me", "billing", "members"))))
        // Someone who left already holds no role for them; with nobody else left, the last one may go.
        assertEquals(FamilySync.MANAGER_FIRST, FamilySync.leaveBlocker("me", listOf(member("me", "members"), member("sam", "members").copy(state = "left"), member("lee"))))
        assertNull(FamilySync.leaveBlocker("me", listOf(member("me", "members"), member("sam", "members").copy(state = "left"))))
    }
}
