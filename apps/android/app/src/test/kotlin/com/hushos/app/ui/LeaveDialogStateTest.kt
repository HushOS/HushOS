package com.hushos.app.ui

import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilySync
import com.hushos.app.data.Opened
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/*
 * The leave dialog's state lives in the model (LeaveAsk), so a rotation or a fold, which recreates every screen, redraws
 * it with its request, the server's words and the plans to confirm; and one request at a time, so a press while one is
 * under way (or a dialog drawn again meanwhile) sends nothing. Through the real model, vault and FakeDrive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LeaveDialogStateTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    private class Host(val vault: Vault) : FamilyHost {
        override val currentVault: Vault get() = vault
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        val notices = java.util.Collections.synchronizedList(ArrayList<String>())
        override fun item(id: String): Opened? = vault.item(id)
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() {}
        override fun notice(text: String, untilRead: Boolean) { notices.add(text) }
        @Volatile var accountReloads = 0
        override fun accountChanged() { accountReloads++ }
    }

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "leave-dialog-state-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() = server.close()

    private fun settled(model: FamiliesModel) {
        val until = System.currentTimeMillis() + 10_000
        while (model.leaving?.busy == true && System.currentTimeMillis() < until) Thread.sleep(20)
        assertFalse("the request settled", model.leaving?.busy == true)
    }

    /*
     * Fails if the dialog's request, words or plans live in the screen (a recreated screen then loses them), or if a
     * press while a request is under way sends another.
     */
    @Test
    fun theDialogsStateOutlivesTheScreenAndASecondPressSendsNothing() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)

        // A refusal: its words are the model's, for whichever screen draws the dialog next.
        family.leaveRefusal = 409 to JSONObject().put("code", "organizer").put("message", "Hand the group’s billing to another member before you leave.")
        model.askLeave(family.groupId)
        assertTrue(model.confirmLeave("Lindqvist family"))
        settled(model)
        assertEquals(LeaveAsk(family.groupId, error = FamilySync.ORGANIZER_FIRST), model.leaving)
        // Still in the family: its plan and pool are still the account's.
        assertEquals(0, host.accountReloads)

        // A lapsed plan named: kept for the next press, which confirms it by id.
        family.leaveRefusal = 409 to JSONObject().put("code", "ends-lapsed").put("message", "You pay for a lapsed plan.")
            .put("data", JSONObject().put("plans", org.json.JSONArray().put(JSONObject().put("id", "sub_1").put("name", "Family Pro").put("standing", "paused"))))
        assertTrue(model.confirmLeave("Lindqvist family"))
        settled(model)
        assertEquals(listOf("sub_1"), model.leaving?.plans?.map { it.id })

        // The leave held on its way: a second press, a reopened dialog and Cancel change nothing and send nothing.
        family.leaveRefusal = null
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.beforeAnswer = { method, path -> if (method == "POST" && path.endsWith("/leave")) { arrived.countDown(); release.await(10, TimeUnit.SECONDS) } }
        val sentBefore = family.leaves.size
        assertTrue(model.confirmLeave("Lindqvist family"))
        assertTrue(arrived.await(10, TimeUnit.SECONDS))
        assertFalse(model.confirmLeave("Lindqvist family"))
        model.askLeave(family.groupId)
        model.dismissLeave()
        assertTrue(model.leaving?.busy == true)
        release.countDown()
        settled(model)
        server.beforeAnswer = null
        assertEquals("one request sent", sentBefore + 1, family.leaves.size)
        assertEquals(listOf("sub_1"), family.leaves.last())
        // Landed: the dialog closes, the person is told, and the page is told to move on.
        assertNull(model.leaving)
        assertEquals(family.groupId, model.leftFamily)
        assertEquals("You left Lindqvist family", host.notices.last())
        // Out of the family: the account's storage and plan are read again, so Account stops showing the family's.
        assertEquals(1, host.accountReloads)
    }
}
