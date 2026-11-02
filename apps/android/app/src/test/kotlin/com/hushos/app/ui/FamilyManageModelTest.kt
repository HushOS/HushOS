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
        override fun lostSession() {}
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
    }

    @After
    fun close() = server.close()

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
}
