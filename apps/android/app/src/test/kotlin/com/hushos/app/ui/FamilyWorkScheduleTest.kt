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
}
