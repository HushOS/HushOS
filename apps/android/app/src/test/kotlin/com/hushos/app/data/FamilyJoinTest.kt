package com.hushos.app.data

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/*
 * Joining on first use (docs/optional-verification.md 3.2, 3.3, 7.2; iOS 3 as #243 rewrote it): a newcomer let in on the
 * web joins with no words, the guard, the record and the settings pin written in that order with the first-use marker in
 * the pin's save; a stop between the guard and the record finishes from the joins record after a relaunch; a not-member
 * answer keeps the guard, so another history served afterwards is refused, never joined.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyJoinTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-join-test")
        family = FamilyFixture(server)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /*
     * Let in on the web, nothing on this phone or in the settings: the join finishes on first use, with the guard and the
     * settings pin at roster 2, the joins record gone and the folder open. The save that put the pin in the settings
     * carries the marker and no check record for this family, so Sam's file reads as nobody vouched for it: no "Verified
     * by", no mark. Fails without the guard write, without the marker in that save, or without asFirstUse.
     */
    @Test
    fun aFirstUseJoinStoresTheGuardMarksTheSettingsAndVouchesForNobody() {
        val saved = ArrayList<JSONObject>()
        server.onSettingsPut = { saved.add(JSONObject(server.settings().json.toString())) }
        val phone = family.phone()
        val outcome = phone.sync.joinStatus(family.groupId)
        assertTrue("$outcome", (outcome as? JoinOutcome.Joined)?.state is FamilyState.Accepted)
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        assertEquals(2uL, phone.records.read(family.member.id, family.groupId)?.rosterVersion)
        assertNull(phone.records.readJoins(family.member.id, family.groupId))
        val first = saved.first { it.optJSONObject("groups")?.has(family.groupId) == true }
        assertTrue(first.has("familyChecksSince"))
        assertFalse(first.optJSONObject("familyChecks")?.has(family.groupId) ?: false)
        assertFalse(phone.sync.familyChecked(family.groupId))
        val file = phone.vault.listChildren(family.rootId).single()
        val verdict = phone.sync.verdicts(listOf(file.node), family.groupId).single()
        assertNull(verdict.mark)
        assertNull(verdict.verifiedBy)
    }

    /*
     * #247 check, round 5: a first-use join commits but its guard can't be stored. Writes into the family's folder (a
     * share of it mounted before the join) are held by the barrier, though route 25 never proved the folder. Fails if
     * the join's failure path doesn't hold the member list's folders before storing the guard.
     */
    @Test
    fun aJoinWhoseGuardCantBeStoredHoldsWritesIntoItsFolders() {
        val phone = family.phone()
        server.shareWithMe(family.fileId)
        server.pinGrace()
        assertNull(phone.vault.mountShares().single().error)
        phone.vault.familyGuardWrites = { false }
        assertTrue(runCatching { phone.sync.joinStatus(family.groupId) }.exceptionOrNull() is GuardUnsaved)
        assertFalse(phone.vault.isFamilyWorkspace(family.workspaceId))
        assertThrows(GuardUnsaved::class.java) { phone.vault.refuseFamilyWrite(family.workspaceId) }
        assertThrows(GuardUnsaved::class.java) { phone.vault.sendingIntoFamily(family.workspaceId) }
    }

    /*
     * Round 7, item 2: after a first-use join, Sam's file reads as written by someone nobody checked. No mark, and Info
     * gets its attribution from the family's verdict: Sam by the name and address the family serves, by account id, so
     * "Added by Sam Lindqvist · Not verified · Check it's Sam" opens the family's check. Fails if the verdict carries no
     * writer (Info then says nothing and offers no check).
     */
    @Test
    fun aFirstUseJoinNamesTheUncheckedWriterForInfo() {
        val phone = family.phone()
        assertTrue((phone.sync.joinStatus(family.groupId) as? JoinOutcome.Joined)?.state is FamilyState.Accepted)
        val file = phone.vault.listChildren(family.rootId).single()
        val verdict = phone.sync.verdicts(listOf(file.node), family.groupId).single()
        assertNull(verdict.mark)
        assertEquals(FamilySeen("Sam Lindqvist", family.creator.id.lowercase(), "sam@example.org"), verdict.seen)
    }

    /*
     * A phone-first join into an account whose settings already pin another family (accepted before first use existed):
     * the save that writes this family's first-use pin also writes the marker and a `before` record for the older family
     * at its own roster, so it keeps reading as checked and this one doesn't. Fails if they are left for a later save.
     */
    @Test
    fun aPhoneFirstJoinWritesTheMarkerAndBeforeRecordsInTheSameSaveAsItsPin() {
        val older = "0a1b2c3d-0000-4000-8000-000000000004"
        server.editSettings { it.setGroupPin(older, family.pin(listOf(family.r1, family.r2))) }
        val saved = ArrayList<JSONObject>()
        server.onSettingsPut = { saved.add(JSONObject(server.settings().json.toString())) }
        val phone = family.phone()
        assertTrue(phone.sync.joinStatus(family.groupId) is JoinOutcome.Joined)
        val first = saved.first { it.optJSONObject("groups")?.has(family.groupId) == true }
        assertTrue(first.has("familyChecksSince"))
        assertEquals("before", first.getJSONObject("familyChecks").getJSONObject(older).getString("how"))
        assertEquals(2, first.getJSONObject("familyChecks").getJSONObject(older).getInt("rosterVersion"))
        assertFalse(first.getJSONObject("familyChecks").has(family.groupId))
        val settings = server.settings()
        assertTrue(settings.familyChecked(older))
        assertFalse(settings.familyChecked(family.groupId))
    }

    /* Accepted but not let in yet: waiting, and nothing of the family is fetched. */
    @Test
    fun anAcceptedInvitationWaitsUntilItsPersonIsLetIn() {
        family.groupState = "accepted"
        val phone = family.phone()
        family.asked.clear()
        assertEquals(JoinOutcome.Waiting, phone.sync.joinStatus(family.groupId))
        assertFalse(family.asked.any { it.contains("/rosters") })
    }

    /*
     * Killed right after the guard was stored, before the device record: the relaunched phone finishes the join from the
     * joins record against the same history. Later, with the record and the settings pin gone, a server that serves a
     * chain short of the guard meets it as a mark: refused, never joined again. Fails if the record is written first, the
     * joins record isn't kept, or the guard isn't a mark.
     */
    @Test
    fun aStopBetweenTheGuardAndTheRecordFinishesFromTheJoinsRecordAndTheGuardRefusesARollback() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        val first = family.phone()
        first.vault.afterFamilyGuard = { throw IllegalStateException("killed") }
        assertThrows(IllegalStateException::class.java) { first.sync.joinStatus(family.groupId) }
        assertEquals(3uL, first.vault.familyGuard.family(family.groupId)?.rosterVersion)
        assertNull(first.records.read(family.member.id, family.groupId))
        assertNotNull(first.records.readJoins(family.member.id, family.groupId))

        val relaunched = family.phone(first.folder)
        assertTrue(relaunched.sync.joinStatus(family.groupId) is JoinOutcome.Joined)
        assertEquals(3uL, relaunched.records.read(family.member.id, family.groupId)?.rosterVersion)
        assertNull(relaunched.records.readJoins(family.member.id, family.groupId))

        // The record and the settings pin lost; only the guard is left, and the server rolls back to roster 2.
        relaunched.records.delete(family.member.id, family.groupId)
        server.editSettings { it.json.remove("groups") }
        family.chain = listOf(family.r1, family.r2)
        family.ignoringAfter = true
        val later = family.phone(first.folder)
        val outcome = runCatching { later.sync.joinStatus(family.groupId) }
        assertFalse("a chain short of the guard joined: $outcome", outcome.getOrNull() is JoinOutcome.Joined)
        assertNull(later.records.read(family.member.id, family.groupId))
    }

    /*
     * Not-member wipes the record and what was opened but never the guard. The server then serves settings without the
     * pin and another history at roster 2, as a fresh invitation would: the join meets the guard and shows the hard
     * warning, never joins. Fails if the wipe deletes the guard or a join passes it as absent.
     */
    @Test
    fun aNotMemberAnswerKeepsTheGuardAndAnotherHistoryAfterItIsRefused() {
        val phone = family.phone()
        assertTrue(phone.sync.joinStatus(family.groupId) is JoinOutcome.Joined)
        family.notMember = true
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        family.notMember = false
        server.editSettings { it.json.remove("groups") }
        family.chain = listOf(family.r1, family.r2Other)
        val outcome = phone.sync.joinStatus(family.groupId)
        assertTrue("$outcome", outcome is JoinOutcome.Fork)
        assertNull(phone.records.read(family.member.id, family.groupId))
    }

    /* One family per account: an invitation opened while in another family names it, and Join is off; the token goes only in a body. */
    @Test
    fun anInvitationWhileInAnotherFamilyNamesItAndJoinIsOff() {
        val invitation = Invitation(Invitation.Family("0a1b2c3d-0000-4000-8000-000000000005", "Ortega family"), "i", family.groupId, "family",
            "Lindqvist family", Invitation.Inviter("x", "Sam", "sam@example.org"), "2026-11-05T10:00:00.000Z")
        val notice = InvitationNotice.of(invitation, null, "me@example.org")
        assertFalse(notice.canAccept)
        assertTrue((notice.note as InvitationNotice.Note.InFamily).words.startsWith("You’re in Ortega family. To join Lindqvist family, leave yours first"))
        val bare = InvitationNotice.of(invitation.copy(inFamily = null), GroupsApiError(409, "in-family", "In a family"), null)
        assertFalse(bare.canAccept)
        val api = GroupsApi(Shared.Session(server.origin, server.token, server.userId, ""))
        assertEquals(410, assertThrows(GroupsApiError::class.java) { api.openInvitation("not a token") }.status)
        assertFalse(server.requests.any { it.contains("invitations") })
    }
}
