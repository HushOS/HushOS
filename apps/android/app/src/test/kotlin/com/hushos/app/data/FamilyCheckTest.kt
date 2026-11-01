package com.hushos.app.data

import com.hushos.core.PinTrust
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
import org.robolectric.annotation.Config

/*
 * Check it's Sam in a family and who reads Verified (docs/optional-verification.md 3.4, 3.8, 6.9, 6.10; iOS's
 * FamilyCheckTests): They match over the words both screens show saves the check record and a verified pin in one save;
 * words that don't match here save nothing; Verified only for a pin whose keys are the member's entry; and the check's
 * "Getting the latest" hands back the fork it found.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyCheckTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private lateinit var phone: FamilyFixture.Phone
    private val sam get() = FamilyMemberRef(family.creator.id.lowercase(), "sam@example.org", "Sam Lindqvist")

    @Before
    fun join() {
        FamilyFixture.signIn(server, "family-check-test")
        family = FamilyFixture(server)
        phone = family.phone()
        assertTrue(phone.sync.joinStatus(family.groupId) is JoinOutcome.Joined)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun view() = (phone.sync.sync(family.summary) as FamilyState.Accepted).view

    /*
     * They match over the words this phone shows: the check record and a verified pin of Sam go in one save, Sam reads
     * Verified, the family now reads as checked, and Sam's file is verified by the family. Fails if the record or the pin
     * isn't saved, or the label doesn't follow the pin.
     */
    @Test
    fun theyMatchSavesTheCheckAndAVerifiedPinAndTheMemberReadsVerified() {
        assertEquals(MemberStanding.NOT_VERIFIED, phone.sync.memberStandings(view())[sam.userId])
        val start = phone.sync.checkCode(family.summary, sam.userId)
        assertTrue(start.state is FamilyState.Accepted)
        val code = start.code as FamilyCheckCode.Code
        assertEquals(12, code.code.size)
        assertEquals(phone.sync.checkMatch(family.groupId, sam, code.rosterVersion, code.code), true to true)
        val settings = server.settings()
        assertEquals(sam.userId, settings.familyCheckWith(family.groupId))
        assertEquals(PinTrust.VERIFIED, settings.pinOf(sam.userId)?.trust)
        assertNull(settings.pinOf(sam.userId)?.trustedVia)
        assertTrue(settings.familyChecked(family.groupId))
        assertEquals(MemberStanding.VERIFIED, phone.sync.memberStandings(view())[sam.userId])
        // Sam's file verifies now by Sam's own pin, with no mark.
        val file = phone.vault.listChildren(family.rootId).single()
        assertNull(phone.sync.verdicts(listOf(file.node), family.groupId).single().mark)
    }

    /* They match over words that aren't this phone's (a misread list, another family): nothing is saved, and Sam stays not verified. */
    @Test
    fun wordsThatDontMatchHereSaveNothing() {
        val code = phone.sync.checkCode(family.summary, sam.userId).code as FamilyCheckCode.Code
        val before = server.settings().json.toString()
        assertEquals(false to false, phone.sync.checkMatch(family.groupId, sam, code.rosterVersion, code.code.reversed()))
        assertEquals(before, server.settings().json.toString())
        assertEquals(MemberStanding.NOT_VERIFIED, phone.sync.memberStandings(view())[sam.userId])
    }

    /*
     * A verified pin that agrees with this phone's guard but holds other keys than Sam's entry: Sam is not Verified,
     * decided from one guarded read. Fails if the label skips the comparison with the entry.
     */
    @Test
    fun aVerifiedPinOfOtherKeysThanTheEntryIsNotVerified() {
        val other = newPerson()
        val pin = ContactPin.ofServed(sam.userId, sam.email, sam.name, WebFixture.served(other.envelope), "2026-10-30T00:00:00Z")!!
        server.editSettings { it.pin(pin) }
        val standings = phone.sync.memberStandings(view())
        assertEquals(MemberStanding.NOT_VERIFIED, standings[sam.userId])
        // The pin itself reads verified and agrees with the guard: only the entry's keys stop it.
        assertTrue(phone.vault.contactStandings()[sam.userId]!!.verified)
    }

    /*
     * Maya pinned Sam first-seen over other keys than the member list names (added without words, then keys planted in
     * the list): Sam's file reads "Keys don't match" and the family vouches for nothing. Fails if conflicts are looked for
     * over verified pins only (iOS 0.10.0's residual, 7.3).
     */
    @Test
    fun aFirstSeenPinThatDisagreesWithAMembersEntryIsAConflict() {
        val other = newPerson()
        val keys = com.hushos.core.pinOfServed(other.servedKeys(), false)
        server.editSettings { it.pin(ContactPin.of(sam.userId, sam.email, sam.name, keys, "2026-10-30T00:00:00Z", "added")) }
        view()
        val file = phone.vault.listChildren(family.rootId).single()
        val verdict = phone.sync.verdicts(listOf(file.node), family.groupId).single()
        assertEquals("Keys don’t match", verdict.mark?.label)
        assertNull(verdict.verifiedBy)
    }

    /*
     * Check it's Sam's "Getting the latest" meets a fork: the outcome comes back (never thrown away), with no words, so the
     * page shows the warning as after any sync, and nothing of the family stays open. Fails if the sync's state is dropped.
     */
    @Test
    fun aCheckThatMeetsAForkHandsBackTheWarning() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        assertNotNull(view())
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        val start = phone.sync.checkCode(family.summary, sam.userId)
        assertTrue("${start.state}", start.state is FamilyState.Fork)
        assertNull(start.code)
        assertNotNull(start.problem)
        assertFalse(phone.vault.areaLedger.isArea(family.workspaceId) && phone.vault.item(family.rootId) != null)
    }
}
