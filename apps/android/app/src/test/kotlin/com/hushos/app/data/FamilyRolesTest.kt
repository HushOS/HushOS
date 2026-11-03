package com.hushos.app.data

import com.hushos.core.ChainRoute
import com.hushos.core.MembersRole
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/*
 * A manager's role changes on a phone (Android 5a part 2; the web's MemberList): Let them manage the family, Stop them
 * managing it, and the organizer handover, through the real Vault, GroupsApi and the core's area ledger against FakeDrive
 * serving rosters the core signs. Maya manages the Lindqvist family and lets Grace in first; every change is the core's,
 * kept before it is sent and sent again byte for byte until the server answers.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyRolesTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    @Before
    fun signIn() {
        FamilyFixture.allowPatch()
        FamilyFixture.signIn(server, "family-roles-test")
        family = FamilyFixture(server)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private val summary get() = family.summary
    private val graceId get() = server.grace.id.lowercase()

    /* Maya's phone, the family as she manages it (as organizer when asked), and Grace let in by her: a member list of four. */
    private fun phone(organizer: Boolean = false, folder: java.io.File? = null): FamilyFixture.Phone {
        if (folder == null) {
            family.storePin(family.pin(family.mayaManages(organizer)))
            family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        }
        val phone = if (folder == null) family.phone() else family.phone(folder)
        assertTrue(phone.sync.sync(summary) is FamilyState.Accepted)
        if (folder == null) {
            assertEquals(LetIn.Landed, phone.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()))
            family.callBodies.clear()
        }
        return phone
    }

    private fun rolesOf(phone: FamilyFixture.Phone, userId: String): List<String> {
        val view = (phone.sync.sync(summary) as FamilyState.Accepted).view
        return view.members.single { it.userId.equals(userId, ignoreCase = true) }.roles
    }

    private fun kept(phone: FamilyFixture.Phone) = phone.sync.outbox.list(family.member.id, family.groupId)
    private fun bodies() = family.memberCalls.map { it.second }

    private fun answer(n: Int, status: Int) = repeat(n) {
        family.memberAnswers.add { _ -> status to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.") }
    }

    private fun grant(phone: FamilyFixture.Phone) = phone.sync.changeRole(summary, graceId, "Grace", MembersRole.GRANT)

    /*
     * The manager rule: Let them manage the family over a first-seen pin (Grace was let in without words) is refused
     * before anything is signed, and asks for a check; once Maya's own words check of Grace is in her settings, it lands
     * with the family's key sealed to Grace. Fails if a manager is made over keys nobody checked.
     */
    @Test
    fun managingTheFamilyWaitsForACheckThenSealsTheKeyToThem() {
        val phone = phone()
        assertEquals(RoleEnd.CheckFirst, grant(phone))
        assertTrue("nothing sent", family.memberCalls.isEmpty())
        assertTrue(kept(phone).isEmpty())
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, grant(phone))
        val body = JSONObject(bodies().single())
        assertEquals(graceId, family.memberCalls.single().first.lowercase())
        assertEquals(graceId, body.getJSONObject("keySeal").getString("holderUserId").lowercase())
        assertTrue("members" in rolesOf(phone, graceId))
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * Stop them managing the family: the call replaces the family's key (the succession, signed with the old key) and
     * seals the new one to every manager who stays, never to Grace; the phone then accepts the chain under the new key.
     * Fails if a manager role is taken away while they keep the key that signs the member list.
     */
    @Test
    fun takingManagingAwayCarriesASuccession() {
        val phone = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, grant(phone))
        assertEquals(RoleEnd.Landed, phone.sync.changeRole(summary, graceId, "Grace", MembersRole.TAKE))
        val body = JSONObject(bodies().last())
        assertTrue("a succession rides with it", body.has("succession"))
        val sealedTo = (0 until body.getJSONArray("seals").length()).map { body.getJSONArray("seals").getJSONObject(it).getString("holderUserId").lowercase() }.toSet()
        assertEquals(setOf(family.creator.id.lowercase(), family.member.id.lowercase()), sealedTo)
        assertEquals(1, family.successions.size)
        val view = (phone.sync.sync(summary) as FamilyState.Accepted).view
        assertEquals(2uL, view.groupKeyVersion)
        assertTrue("members" !in view.members.single { it.userId.equals(graceId, ignoreCase = true) }.roles)
    }

    /* No answer, twice, then one: the very same bytes each time. Fails if a role change is signed again after an unknown outcome. */
    @Test
    fun anUnknownOutcomeResendsTheSameRoleChange() {
        val phone = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        answer(2, 503)
        assertEquals(RoleEnd.Landed, grant(phone))
        assertEquals(3, bodies().size)
        assertEquals(1, bodies().toSet().size)
    }

    /*
     * No answer three times: kept. The app is killed; on relaunch the kept change is sent as it was and lands, nothing
     * signed again. Fails if a kept role change is lost with the process, or signed anew.
     */
    @Test
    fun aKeptRoleChangeSurvivesAKillAndARelaunch() {
        val first = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        answer(3, 503)
        assertTrue(grant(first) is RoleEnd.Pending)
        assertEquals(1, kept(first).size)
        val next = phone(folder = first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals(1, bodies().toSet().size)
        assertTrue("members" in rolesOf(next, graceId))
    }

    /*
     * Pressed again while the first is unanswered: the kept change goes again, byte for byte, nothing new signed.
     * Fails if a second, competing role change is staged beside one that may still land.
     */
    @Test
    fun pressingAgainWhileUnansweredSignsNothingNew() {
        val phone = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        answer(6, 503)
        assertTrue(grant(phone) is RoleEnd.Pending)
        assertTrue(grant(phone) is RoleEnd.Pending)
        assertEquals(1, kept(phone).size)
        assertEquals(6, bodies().size)
        assertEquals(1, bodies().toSet().size)
    }

    /*
     * Grace's grant kept unanswered, then Ada is made a manager: Ada's call alone is sent, and Grace's stays kept, never
     * sent in its place. Fails if one person's kept role change decides another's.
     */
    @Test
    fun anotherPersonsKeptRoleChangeIsLeftAlone() {
        val phone = phone()
        val ada = server.another("ada@example.org", "Ada Lovelace")
        family.waiting(ada, "ada@example.org", "Ada Lovelace")
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()))
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        family.verifyPin(ada, "ada@example.org", "Ada Lovelace")
        answer(3, 503)
        assertTrue(grant(phone) is RoleEnd.Pending)
        val graceKept = kept(phone).single()
        assertEquals(RoleEnd.Landed, phone.sync.changeRole(summary, ada.id, "Ada", MembersRole.GRANT))
        assertEquals(List(3) { graceId } + ada.id.lowercase(), family.memberCalls.map { it.first.lowercase() })
        assertEquals(listOf(graceKept), kept(phone))
    }

    /*
     * Another manager's change lands first (`stale`): dropped, the family synced, and the change signed again over the
     * winner, which lands. Fails if a stale role change is resent or kept.
     */
    @Test
    fun staleDropsTheRoleChangeAndSignsAgainOverTheWinner() {
        val phone = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        family.memberAnswers.add { _ ->
            family.samChangesTheList()
            409 to JSONObject().put("code", "stale").put("message", "Another change to the family landed first.")
        }
        assertEquals(RoleEnd.Landed, grant(phone))
        assertEquals(2, bodies().size)
        assertNotEquals(bodies()[0], bodies()[1])
        assertTrue(kept(phone).isEmpty())
        assertTrue("members" in rolesOf(phone, graceId))
    }

    /*
     * Make them the organizer: billing given to Grace, then let go of by Maya, in that order, and the handover's record
     * gone. Fails if Maya lets go first (a family with no organizer), or keeps it.
     */
    @Test
    fun theHandoverGivesBillingThenLetsGoOfIt() {
        val phone = phone(organizer = true)
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, phone.sync.handOver(summary, graceId, "Grace"))
        assertEquals(listOf(graceId, family.member.id.lowercase()), family.memberCalls.map { it.first.lowercase() })
        assertTrue("billing" in rolesOf(phone, graceId))
        assertTrue("billing" !in rolesOf(phone, family.member.id))
        assertNull(phone.sync.outbox.handover(family.member.id, family.groupId))
    }

    /*
     * The half-finished handover: billing given to Grace, then the app stops before Maya lets go of it (here, her
     * connection drops). On relaunch the family page's resume finishes it: one organizer, Grace, and the person told.
     * Fails if a handover stopped in the middle leaves two organizers for good.
     */
    @Test
    fun aHandoverStoppedInTheMiddleIsFinishedAtTheNextOpen() {
        val first = phone(organizer = true)
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        // Billing lands with Grace; then the connection drops before Maya's own step is staged.
        family.memberAnswers.add { body ->
            val landed = family.apply(body, null)
            family.rostersFail = true
            landed
        }
        assertTrue(runCatching { first.sync.handOver(summary, graceId, "Grace") }.isFailure)
        family.rostersFail = false
        assertEquals(FamilyOutbox.KeptHandover(graceId, staged = true), first.sync.outbox.handover(family.member.id, family.groupId))
        assertEquals(1, family.memberCalls.size)
        val next = phone(organizer = true, folder = first.folder)
        val handed = ArrayList<Pair<String, RoleEnd>>()
        next.sync.resumeOutbox(summary, names = { "Grace" }, handed = { to, end -> handed.add(to to end) })
        assertEquals(listOf(graceId to RoleEnd.Landed), handed)
        assertTrue("billing" in rolesOf(next, graceId))
        assertTrue("billing" !in rolesOf(next, family.member.id))
        assertNull(next.sync.outbox.handover(family.member.id, family.groupId))
    }

    /*
     * A kept Let them in another manager's change overtook (the chain moved past the roster it was built on): the resume
     * says so before its entry is deleted, naming the admission, so the person lets them in again. Fails if an overtaken
     * admission is dropped without a word.
     */
    @Test
    fun anOvertakenAdmissionIsToldBeforeItIsDropped() {
        family.storePin(family.pin(family.mayaManages()))
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        val first = family.phone()
        assertTrue(first.sync.sync(summary) is FamilyState.Accepted)
        repeat(3) { family.admitAnswers.add { _ -> 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.") } }
        assertTrue(first.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()) is LetIn.Pending)
        family.samChangesTheList()
        val next = family.phone(first.folder)
        assertTrue(next.sync.sync(summary) is FamilyState.Accepted)
        val told = ArrayList<Pair<ChainRoute?, CallEnd>>()
        next.sync.resumeOutbox(summary, told = { route, end ->
            // Told while its entry is still kept: the deletion comes after.
            assertEquals(1, kept(next).size)
            told.add(route to end)
        })
        assertEquals(listOf<Pair<ChainRoute?, CallEnd>>(ChainRoute.Admit(graceId) to CallEnd.Stale), told)
        assertTrue(kept(next).isEmpty())
    }

    /*
     * Make them the organizer for someone this phone hasn't verified: asked to check first, nothing signed or sent, and
     * no handover left waiting. Fails if the organizer role is handed to keys nobody checked (the web's needsCheckFor).
     */
    @Test
    fun theHandoverWaitsForACheckToo() {
        val phone = phone(organizer = true)
        assertEquals(RoleEnd.CheckFirst, phone.sync.handOver(summary, graceId, "Grace"))
        assertTrue(family.memberCalls.isEmpty())
        assertTrue(kept(phone).isEmpty())
        assertNull(phone.sync.outbox.handover(family.member.id, family.groupId))
    }

    /*
     * Grace is verified in the settings, but this device's guard can't be read: the grant stops before anything is signed
     * (the guard's own words), whatever the row said. Fails if a manager role is given over a pin the guard didn't vouch for.
     */
    @Test
    fun aGuardThatCantBeReadStopsTheGrant() {
        val phone = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        val guard = java.io.File(RuntimeEnvironment.getApplication().noBackupFilesDir, ContactGuard.FOLDER).listFiles()!!
            .single { it.name.endsWith(".json") && !it.name.endsWith(".families.json") }
        guard.writeText("not a guard")
        val refused = runCatching { grant(phone) }.exceptionOrNull()
        assertTrue("$refused", refused is GuardUnreadable)
        assertTrue("nothing sent", family.memberCalls.isEmpty())
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * A grant for Grace still unanswered when Maya makes her the organizer: the handover can't be staged yet, so it is
     * kept, and once the grant lands the next open stages the handover and finishes it. Fails if a handover blocked behind
     * an earlier change for the same person is dropped as though it had been refused.
     */
    @Test
    fun aHandoverBlockedBehindAnEarlierChangeGoesOnOnceThatLands() {
        val phone = phone(organizer = true)
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        answer(6, 503)
        assertTrue(grant(phone) is RoleEnd.Pending)
        assertTrue(phone.sync.handOver(summary, graceId, "Grace") is RoleEnd.Pending)
        assertEquals(FamilyOutbox.KeptHandover(graceId, staged = false), phone.sync.outbox.handover(family.member.id, family.groupId))
        val handed = ArrayList<Pair<String, RoleEnd>>()
        phone.sync.resumeOutbox(summary, names = { "Grace" }, handed = { to, end -> handed.add(to to end) })
        assertEquals(listOf(graceId to RoleEnd.Landed), handed)
        assertTrue("billing" in rolesOf(phone, graceId))
        assertTrue("members" in rolesOf(phone, graceId))
        assertTrue("billing" !in rolesOf(phone, family.member.id))
        assertNull(phone.sync.outbox.handover(family.member.id, family.groupId))
    }
}
