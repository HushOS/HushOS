package com.hushos.app.ui

import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyState
import com.hushos.app.data.LetIn
import com.hushos.app.data.Opened
import com.hushos.app.data.PendingPerson
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.handOver
import com.hushos.app.data.letIn
import com.hushos.app.data.outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/*
 * The organizer handover on a manager's family page, through the real model, vault and FakeDrive: Maya is the organizer,
 * Grace is in the family and checked. What the page shows once a handover the app stopped in the middle of is finished.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyRolesModelTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    private class Host(@Volatile var vault: Vault) : FamilyHost {
        override val currentVault: Vault get() = vault
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        @Volatile var shown: Notice? = null
        val notices = NoticeQueue { shown = it }
        fun read(): List<String> = generateSequence { shown?.text?.also { notices.dismiss() } }.toList()
        override fun item(id: String): Opened? = vault.item(id)
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() {}
        override fun notice(text: String, untilRead: Boolean) {
            val notice = Notice(System.nanoTime(), text, {}, if (untilRead) "OK" else "Undo")
            if (untilRead) notices.untilRead(notice) else notices.passing(notice)
        }
    }

    private lateinit var host: Host
    private lateinit var model: FamiliesModel

    @Before
    fun signIn() {
        FamilyFixture.allowPatch()
        FamilyFixture.signIn(server, "family-roles-model-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(family.mayaManages(organizer = true)))
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        val app = RuntimeEnvironment.getApplication()
        host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        model = FamiliesModel(host)
        assertEquals(LetIn.Landed, host.vault.families.letIn(family.summary, family.pendingRows.map(PendingPerson::from).single()))
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
    }

    @After
    fun close() = server.close()

    private fun rolesShown(userId: String): List<String> =
        (model.states[family.groupId] as FamilyState.Accepted).view.members.single { it.userId.equals(userId, ignoreCase = true) }.roles

    /*
     * Billing given to Grace, then the app stopped before Maya let go of it; the page opens (the resume finishes it, with
     * no call left in the outbox): it says Grace is the organizer and shows her so, Maya no longer. Fails if the page
     * keeps showing two organizers after the handover it finished.
     */
    @Test
    fun aResumedHandoverThatLandsShowsTheNewOrganizer() {
        family.memberAnswers.add { body ->
            val landed = family.apply(body, null)
            family.rostersFail = true
            landed
        }
        assertTrue(runCatching { host.vault.families.handOver(family.summary, server.grace.id, "Grace") }.isFailure)
        family.rostersFail = false
        runBlocking { model.refreshFamilies(force = true) }
        // Both organizers, as the member list stands between the two calls.
        assertTrue("billing" in rolesShown(family.member.id) && "billing" in rolesShown(server.grace.id))
        runBlocking { model.loadManaged(family.groupId) }
        assertTrue("billing" in rolesShown(server.grace.id))
        assertTrue("Maya is still shown as the organizer", "billing" !in rolesShown(family.member.id))
        assertTrue(host.read().contains("Grace is the organizer"))
    }

    /*
     * Make them the organizer from a row, for someone not verified here: Check it's Grace first, as for managing the
     * family, and nothing confirmed. Stopping someone managing asks no check. Fails if the organizer role skips the check.
     */
    @Test
    fun makingSomeoneTheOrganizerAsksForACheckFirst() {
        runBlocking { model.refreshFamilies(force = true) }
        val ref = com.hushos.app.data.FamilyMemberRef(server.grace.id, "grace@example.org", "Grace Hopper")
        val organizer = RoleAsk(family.groupId, ref, RoleKind.ORGANIZER)
        model.askRole(organizer, verified = false)
        assertEquals(organizer, model.checkFirst)
        assertEquals(null, model.roleAsk)
        model.dismissCheckFirst()
        val stop = RoleAsk(family.groupId, ref, RoleKind.STOP)
        model.askRole(stop, verified = false)
        assertEquals(stop, model.roleAsk)
    }

    private fun until(what: String, check: () -> Boolean) {
        val end = System.currentTimeMillis() + 15_000
        while (!check() && System.currentTimeMillis() < end) Thread.sleep(20)
        assertTrue(what, check())
    }

    private fun handOverFromTheRow() {
        runBlocking { model.refreshFamilies(force = true) }
        val ref = com.hushos.app.data.FamilyMemberRef(server.grace.id, "grace@example.org", "Grace Hopper")
        model.askRole(RoleAsk(family.groupId, ref, RoleKind.ORGANIZER), verified = true)
        model.confirmRole()
        until("the handover finished") { model.roleBusy == null && host.shown != null }
    }

    private fun halfDoneShown() = (model.states[family.groupId] as? FamilyState.Accepted)?.view
        ?.let { com.hushos.app.data.handoverToFinish(it, family.member.id) }?.lowercase()

    /*
     * Make them the organizer: billing lands with Grace, Maya's last step is refused. The page reads the family again at
     * once, so it shows both organizers and Finish handing over. Fails if the page keeps the member list from before.
     */
    @Test
    fun aRefusedLastStepShowsFinishHandingOverAtOnce() {
        family.memberAnswers.add { body -> family.apply(body, null) }
        family.memberAnswers.add { _ -> 409 to JSONObject().put("code", "held").put("message", "Paused.") }
        handOverFromTheRow()
        until("the page read the family again") { halfDoneShown() == server.grace.id.lowercase() }
    }

    /*
     * Billing lands with Grace, then the connection drops before Maya's last step: the error is said, and the page reads
     * the family again, showing Finish handing over. Fails if a failure part way leaves the page as it was before.
     */
    @Test
    fun aFailurePartWayStillShowsTheFamilyAsItIs() {
        family.memberAnswers.add { body -> val landed = family.apply(body, null); family.rosterFailures = 2; landed }
        handOverFromTheRow()
        until("the page read the family again") { halfDoneShown() == server.grace.id.lowercase() }
    }

    /*
     * A handover kept unstaged (its first call never made: the connection dropped), then the page opens: the resume gives
     * Grace billing, and Maya's last step is refused. Nothing was in the outbox, so only the handover's outcome says the
     * family changed; the page reads it again and shows Finish handing over. Fails if a resume that completes part way
     * leaves the page as it was.
     */
    @Test
    fun aResumedHandoverThatPartlyCompletesShowsTheFamilyAsItIs() {
        family.rosterFailures = 1
        assertTrue(runCatching { host.vault.families.handOver(family.summary, server.grace.id, "Grace") }.isFailure)
        runBlocking { model.refreshFamilies(force = true) }
        assertEquals(null, halfDoneShown())
        family.memberAnswers.add { body -> family.apply(body, null) }
        family.memberAnswers.add { _ -> 409 to JSONObject().put("code", "held").put("message", "Paused.") }
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(server.grace.id.lowercase(), halfDoneShown())
    }

    /*
     * The same, but the resume fails once billing landed (the connection drops before Maya's last step): the failure is
     * said, and the page still reads the family again. Fails if a failed resume skips the read.
     */
    @Test
    fun aResumeThatFailsPartWayStillShowsTheFamilyAsItIs() {
        family.rosterFailures = 1
        assertTrue(runCatching { host.vault.families.handOver(family.summary, server.grace.id, "Grace") }.isFailure)
        runBlocking { model.refreshFamilies(force = true) }
        family.memberAnswers.add { body -> val landed = family.apply(body, null); family.rosterFailures = 2; landed }
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(server.grace.id.lowercase(), halfDoneShown())
    }

    /*
     * A role change still out when the account signs out and back in (a new session), and the new session starts its own:
     * the old one's answer arrives and leaves the new one's busy row alone. Fails if an ended session's answer clears what
     * the next session is doing (its row would take another press mid-change).
     */
    @Test
    fun anEndedSessionsAnswerLeavesTheNewSessionsChangeAlone() {
        runBlocking { model.refreshFamilies(force = true) }
        val ref = com.hushos.app.data.FamilyMemberRef(server.grace.id, "grace@example.org", "Grace Hopper")
        val first = java.util.concurrent.CountDownLatch(1)
        val second = java.util.concurrent.CountDownLatch(1)
        val sends = java.util.concurrent.atomic.AtomicInteger()
        server.beforeAnswer = { method, path ->
            if (method == "PATCH" && path.contains("/members/")) (if (sends.incrementAndGet() == 1) first else second).await(15, java.util.concurrent.TimeUnit.SECONDS)
        }
        model.askRole(RoleAsk(family.groupId, ref, RoleKind.MANAGE), verified = true)
        model.confirmRole()
        until("the old session's change is out") { sends.get() == 1 }
        // Signed out and in again, as DriveViewModel does: a new vault, the families reset; the new session starts its own change.
        host.vault = RuntimeEnvironment.getApplication().let { Vault(it, DriveApi(Shared.session(it)!!)) }
        model.reset()
        runBlocking { model.refreshFamilies(force = true) }
        model.askRole(RoleAsk(family.groupId, ref, RoleKind.MANAGE), verified = true)
        model.confirmRole()
        val busy = model.roleBusy
        assertTrue(busy != null)
        // The old change answers (the family's turn it held is let go of); the new one goes out after it.
        first.countDown()
        until("the new session's change is out") { sends.get() == 2 }
        Thread.sleep(500)
        assertEquals("the old answer cleared the new session's change", busy, model.roleBusy)
        second.countDown()
        until("the new session's change finished") { model.roleBusy == null }
        server.beforeAnswer = null
    }

    /*
     * A handover kept unstaged, then the page opens with nothing in the outbox: the resume gives Grace billing, and Maya's
     * last step gets no answer (kept for the next open). The page still reads the family again and shows Finish handing
     * over. Fails if a resumed handover that ends pending says nothing to the page.
     */
    @Test
    fun aResumedHandoverLeftPendingShowsTheFamilyAsItIs() {
        family.rosterFailures = 1
        assertTrue(runCatching { host.vault.families.handOver(family.summary, server.grace.id, "Grace") }.isFailure)
        runBlocking { model.refreshFamilies(force = true) }
        assertEquals(null, halfDoneShown())
        family.memberAnswers.add { body -> family.apply(body, null) }
        repeat(3) { family.memberAnswers.add { _ -> 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.") } }
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(server.grace.id.lowercase(), halfDoneShown())
        assertTrue("the handover is kept", host.vault.families.outbox.handover(family.member.id, family.groupId) != null)
    }
}
