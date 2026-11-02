package com.hushos.app.ui

import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyOutbox
import com.hushos.app.data.FamilyState
import com.hushos.app.data.LetIn
import com.hushos.app.data.Opened
import com.hushos.app.data.PendingPerson
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.letIn
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
import java.util.UUID

/*
 * A manager's family page through the real model, vault and FakeDrive: Maya manages the Lindqvist family, Grace waits to
 * be let in. What the screens are told, and when the lists they draw are read again.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyManageModelTest {
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
        @Volatile var lostSessions = 0
        override fun lostSession() { lostSessions++ }
        override fun notice(text: String, untilRead: Boolean) { notices.add(text) }
    }

    private lateinit var host: Host
    private lateinit var model: FamiliesModel

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-manage-model-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(family.mayaManages()))
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        val app = RuntimeEnvironment.getApplication()
        host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        assertTrue(model.manages(family.groupId))
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(listOf(server.grace.id.lowercase()), model.waiting[family.groupId]?.map { it.userId.lowercase() })
        assertEquals(emptyList<Any>(), model.invitations[family.groupId])
        assertEquals(null, model.managedErrors[family.groupId])
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /*
     * Someone accepts an invitation: who waits changes, the member list doesn't. Pull to refresh reads who waits again.
     * Fails if a refresh reads only the family, so the new person never shows until the page is opened again.
     */
    @Test
    fun pullToRefreshReadsWhoWaitsAgain() {
        val ada = server.another("ada@example.org", "Ada Lovelace")
        family.waiting(ada, "ada@example.org", "Ada Lovelace")
        runBlocking { model.refreshPage(family.groupId) }
        assertEquals(setOf(server.grace.id.lowercase(), ada.id.lowercase()), model.waiting[family.groupId]?.map { it.userId.lowercase() }?.toSet())
    }

    /*
     * At the page's open, what the kept sends came to is said: an entry this phone can no longer open (sealed before a
     * master-key change) is deleted and said lost, in the web's words; a kept Let them in the server refuses says why,
     * naming the person. Fails if either is dropped without a word.
     */
    @Test
    fun whatResumedSendsCameToIsSaid() {
        repeat(3) {
            family.admitAnswers.add { _ -> 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.") }
        }
        val grace = family.pendingRows.map(PendingPerson::from).single()
        assertTrue(host.vault.families.letIn(family.summary, grace) is LetIn.Pending)
        family.admitAnswers.add { _ -> 409 to JSONObject().put("code", "not-pending").put("message", "They are not waiting to join.") }
        val outbox = FamilyOutbox.of(RuntimeEnvironment.getApplication())
        outbox.put(family.member.id, family.groupId, UUID.randomUUID().toString(), "AAAA")
        host.notices.clear()
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(setOf("A change to Lindqvist family hadn’t reached the server and couldn’t be opened on this device. Make it again.",
            "Grace isn’t waiting to join any more."), host.notices.toSet())
        assertTrue(outbox.list(family.member.id, family.groupId).isEmpty())
    }

    /*
     * Who waits can't be read: the rows last read stay, and why is said, with Try again; the next read that succeeds clears
     * it. A lost session goes to the lost-session handling. Fails if a failed read empties the section silently, leaves it
     * looking current, or swallows a sign-out.
     */
    @Test
    fun aListThatDoesntLoadIsSaidAndKeepsItsRows() {
        family.pendingAnswer = 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(listOf(server.grace.id.lowercase()), model.waiting[family.groupId]?.map { it.userId.lowercase() })
        assertEquals("HushOS couldn’t do that just now. Try again in a moment.", model.managedErrors[family.groupId])
        family.pendingAnswer = null
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(null, model.managedErrors[family.groupId])
        assertEquals(0, host.lostSessions)
        family.pendingAnswer = 401 to JSONObject().put("message", "Sign in again.")
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(1, host.lostSessions)
    }

    /*
     * Route 16 serves someone's keys that don't read whole: the list is said not to have loaded, never shown with a person
     * whose keys are missing. Fails if a malformed identity reads as none.
     */
    @Test
    fun aWaitingPersonWhoseKeysDontReadFailsTheList() {
        family.pendingRows.add(JSONObject().put("userId", UUID.randomUUID().toString()).put("name", "Ada Lovelace").put("email", "ada@example.org")
            .put("roles", org.json.JSONArray()).put("acceptedAt", "2026-11-02T10:00:00.000Z").put("identity", JSONObject().put("keyVersion", 1)).put("inFamily", false))
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(listOf(server.grace.id.lowercase()), model.waiting[family.groupId]?.map { it.userId.lowercase() })
        assertTrue(model.managedErrors[family.groupId] != null)
    }

    private fun until(what: String, check: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!check() && System.currentTimeMillis() < end) Thread.sleep(20)
        assertTrue(what, check())
    }

    /*
     * The session ends while Invite someone, Not now or Cancel invitation is on its way (a 401): each goes to the
     * lost-session handling, as Let them in and the lists do, and leaves no dialog or row words behind. Fails if a
     * sign-out is shown as an ordinary refusal on the dialog or the row.
     */
    @Test
    fun aSessionThatEndsMidActionGoesToTheLostSession() {
        family.manageAnswer = 401 to JSONObject().put("message", "Sign in again.")
        model.askInvite(family.groupId)
        model.typeInvite("ada@example.org")
        model.sendInvite()
        until("the invite's 401 went to the lost session") { host.lostSessions == 1 }
        assertEquals(null, model.inviting)
        val grace = family.pendingRows.map(PendingPerson::from).single()
        model.turnDown(family.groupId, grace)
        until("Not now's 401 went to the lost session") { host.lostSessions == 2 }
        assertEquals(WaitingRow(), model.waitingRow(family.groupId, grace.userId))
        model.cancelInvitation(family.groupId, com.hushos.app.data.OpenInvitation(UUID.randomUUID().toString(), "ada@example.org", null, "2026-11-10T00:00:00.000Z"))
        until("Cancel invitation's 401 went to the lost session") { host.lostSessions == 3 }
        assertTrue(host.notices.none { it.startsWith("Couldn’t cancel it.") })
    }

    /*
     * A refresh's read of the invitations is still on its way, made before Ada's invitation was cancelled, when the cancel
     * lands and its own reload shows her gone; then the old answer arrives. It is dropped: the cancelled invitation stays
     * gone. Fails if a late answer overwrites the state a later change left.
     */
    @Test
    fun aRefreshAnsweredAfterACancelNeverBringsTheInvitationBack() {
        val id = UUID.randomUUID().toString()
        val ada = JSONObject().put("id", id).put("email", "ada@example.org").put("invitedBy", JSONObject.NULL).put("expiresAt", "2026-11-10T00:00:00.000Z")
        family.invitationRows.add(ada)
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(listOf(id), model.invitations[family.groupId]?.map { it.id })
        val arrived = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        var held = false
        server.beforeAnswer = { method, path ->
            if (!held && method == "GET" && path == "groups/${family.groupId}/invitations") {
                held = true
                // Read now, before the cancel; answered once released.
                family.readBefore.set(listOf(ada))
                arrived.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        val refresh = Thread { runBlocking { model.loadManaged(family.groupId) } }.apply { start() }
        assertTrue(arrived.await(10, java.util.concurrent.TimeUnit.SECONDS))
        model.cancelInvitation(family.groupId, model.invitations[family.groupId]!!.single())
        until("the cancel's own reload shows it gone") { model.invitations[family.groupId]?.isEmpty() == true }
        release.countDown()
        refresh.join(10_000)
        server.beforeAnswer = null
        assertTrue(model.invitations[family.groupId]!!.isEmpty())
        assertTrue(family.invitationRows.isEmpty())
    }

    /*
     * Who waits fails as any request can, and the invitations answer 401: the lost session wins, whichever read failed
     * first. Fails if the first failure's words are shown and the sign-out is dropped.
     */
    @Test
    fun aLostSessionFromEitherListIsALostSession() {
        family.pendingAnswer = 503 to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
        family.invitationsAnswer = 401 to JSONObject().put("message", "Sign in again.")
        runBlocking { model.loadManaged(family.groupId) }
        assertEquals(1, host.lostSessions)
    }
}
