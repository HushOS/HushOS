package com.hushos.app.ui

import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyState
import com.hushos.app.data.Opened
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
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
 * Whether the app keeps the background family check scheduled (FamilyHost.familyWork) through the real model, vault and
 * FakeDrive: while the account is in a family, and while this phone still keeps a family the server hasn't confirmed it
 * left; only once nothing is listed and nothing is kept does it go.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyWorkScheduleTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    private class Host(val vault: Vault) : FamilyHost {
        override val currentVault: Vault get() = vault
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        val scheduled = ArrayList<Boolean>()
        override fun item(id: String): Opened? = vault.item(id)
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() {}
        override fun familyWork(inFamily: Boolean) { scheduled.add(inFamily) }
    }

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-work-schedule-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() = server.close()

    /* Fails if an unlisted family whose removal got no answer cancels the background check. */
    @Test
    fun theBackgroundCheckStaysWhileARemovalIsUnconfirmed() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        assertEquals(true, host.scheduled.last())
        family.listed = false
        family.rostersFail = true
        runBlocking { model.refreshFamilies(force = true) }
        assertEquals("kept while unconfirmed", true, host.scheduled.last())
        family.rostersFail = false
        family.notMember = true
        runBlocking { model.refreshFamilies(force = true) }
        assertEquals(FamilyState.Wiped, model.states[family.groupId])
        assertEquals(false, host.scheduled.last())
    }

    /*
     * The background work, using the app's vault, finds the removal first: the screens let go of the family too (its
     * state removed, its folders saying so), not only the vault. Fails if a removal the background work found never
     * reaches the model.
     */
    @Test
    fun aRemovalTheBackgroundWorkFindsReachesTheScreens() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        family.listed = false
        family.notMember = true
        assertEquals(com.hushos.app.data.FamilyWalkWork.Outcome.DONE, com.hushos.app.data.FamilyWalkWork.run(app, host.vault) {})
        assertEquals(FamilyState.Wiped, model.states[family.groupId])
        assertTrue(model.problems.values.any { it == FamilyProblem.Removed })
    }

    /*
     * Route 2 still lists the family but its member list answers not-member: the background work's own sync wipes it,
     * and the screens let go of it too. Fails if a wipe from a sync (not only route 2's reconciliation) never reaches them.
     */
    @Test
    fun aRemovalTheBackgroundWorksSyncFindsReachesTheScreens() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        family.notMember = true
        com.hushos.app.data.FamilyWalkWork.run(app, host.vault) {}
        assertEquals(FamilyState.Wiped, model.states[family.groupId])
        assertTrue(model.problems.values.any { it == FamilyProblem.Removed })
    }

    /*
     * The background work's sync meets not-member, but the wipe can't finish (the family guard can't be read): the family
     * is refused, and the screens let go of it too, saying why, rather than drawing it as accepted. Fails if only a
     * finished wipe reaches the screens.
     */
    @Test
    fun aRemovalWhoseWipeFailsStillReachesTheScreens() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        family.notMember = true
        val folder = host.vault.familyGuard.file.parentFile!!
        try {
            assertTrue(folder.setExecutable(false, false) && folder.setReadable(false, false))
            com.hushos.app.data.FamilyWalkWork.run(app, host.vault) {}
        } finally {
            folder.setExecutable(true, false)
            folder.setReadable(true, false)
        }
        val state = model.states[family.groupId]
        assertTrue("$state", state is FamilyState.Failed && state.removal)
        // What was drawn of the family is let go of: its accepted view is gone from the screens.
        assertTrue(model.shown[family.groupId] == null)
    }

    /*
     * The background work's sync finds the member list shown differently (a fork): the family's warning shows on the
     * screens and what they drew of it goes, as for the app's own sync. Fails if a refusal the background work met never
     * reaches the screens.
     */
    @Test
    fun aForkTheBackgroundWorkFindsReachesTheScreens() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        assertTrue(model.shown[family.groupId] != null)
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        com.hushos.app.data.FamilyWalkWork.run(app, host.vault) {}
        assertTrue("${model.states[family.groupId]}", model.states[family.groupId] is FamilyState.Fork)
        assertTrue(model.shown[family.groupId] == null)
    }

    /* Fails if a join that lands with nothing due leaves the background check unscheduled. */
    @Test
    fun joiningSchedulesTheBackgroundCheck() {
        val app = RuntimeEnvironment.getApplication()
        val host = Host(Vault(app, DriveApi(Shared.session(app)!!)))
        val model = FamiliesModel(host)
        val session = model.begin()!!
        val state = host.vault.families.sync(family.summary)
        assertTrue(state is FamilyState.Accepted)
        runBlocking { model.joined(family.groupId, state, session) }
        assertEquals(true, host.scheduled.lastOrNull())
    }
}
