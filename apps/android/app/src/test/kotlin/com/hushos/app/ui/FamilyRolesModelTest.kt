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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
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

    private class Host(val vault: Vault) : FamilyHost {
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
}
