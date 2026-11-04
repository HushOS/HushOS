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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import kotlin.concurrent.thread

/*
 * Round 5, item 1, through the real model, vaults and FakeDrive: a family folder is listed while its family's check is
 * stale, so the listing first checks the family, and the account switches while that check is out. The check's answer is
 * dropped and the listing that would follow it sends nothing for the new session, so neither the old account's rows nor
 * its 401 reach the new one. Fails if any step after the suspension reads the session current at that step.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamiliesModelSessionTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    /* Listings of the family folder the server answered after the account switched. */
    private val listedAfterSwitch = java.util.concurrent.atomic.AtomicInteger()
    @Volatile private var switched = false

    private class Host(@Volatile var vault: Vault?) : FamilyHost {
        override val currentVault: Vault? get() = vault
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        @Volatile var lost = 0
        override fun item(id: String): Opened? = vault?.item(id)
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() { lost++ }
    }

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "families-model-session-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() = server.close()

    private fun vault() = RuntimeEnvironment.getApplication().let { Vault(it, DriveApi(Shared.session(it)!!)) }

    /* The model with the family accepted and its folder known, its check then made stale; plus the latch the next group request waits on. */
    private fun accepted(host: Host, clock: LongArray): Pair<FamiliesModel, Pair<CountDownLatch, CountDownLatch>> {
        val model = FamiliesModel(host) { clock[0] }
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        assertTrue(model.isFamilyFolder(family.rootId))
        clock[0] += 200_000
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val inner = server.extraRoutes!!
        var held = false
        server.extraRoutes = { method, segments, query, body ->
            if (switched && segments.joinToString("/") == "drive/nodes/${family.rootId}/children") listedAfterSwitch.incrementAndGet()
            if (!held && segments.firstOrNull() == "groups") {
                held = true
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
            inner(method, segments, query, body)
        }
        return model to (started to release)
    }

    /* Lists the family folder on a thread of its own, switches the account while the family's check is out, then lets it answer. */
    private fun switchWhileChecking(host: Host, model: FamiliesModel, latches: Pair<CountDownLatch, CountDownLatch>) {
        val (started, release) = latches
        val done = CountDownLatch(1)
        thread { runBlocking { model.refreshFolder(family.rootId) }; done.countDown() }
        assertTrue("the family's check never went out", started.await(10, TimeUnit.SECONDS))
        // Another account signs in, as DriveViewModel's signedIn does: a new vault, the families reset, a fresh drive state.
        host.vault = vault()
        switched = true
        model.reset()
        host.state.value = DriveState()
        release.countDown()
        assertTrue(done.await(10, TimeUnit.SECONDS))
    }

    @Test
    fun theOldAccountsRowsNeverReachTheNewSession() {
        val host = Host(vault())
        val clock = longArrayOf(1_000_000)
        val (model, latches) = accepted(host, clock)
        switchWhileChecking(host, model, latches)
        assertFalse("the old account's rows reached the new session", host.state.value.folders.containsKey(family.rootId))
        assertEquals("a listing went out for the ended session", 0, listedAfterSwitch.get())
        assertTrue("the old account's family reached the new session", model.states.isEmpty())
    }

    @Test
    fun theOldAccounts401NeverSignsTheNewSessionOut() {
        val host = Host(vault())
        val clock = longArrayOf(1_000_000)
        val (model, latches) = accepted(host, clock)
        // The old account's session expired meanwhile: its listing answers 401.
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (segments.joinToString("/") == "drive/nodes/${family.rootId}/children") 401 to JSONObject().put("message", "Sign in") else inner(method, segments, query, body)
        }
        switchWhileChecking(host, model, latches)
        assertEquals("the old account's 401 signed the new session out", 0, host.lost)
        assertFalse(host.state.value.folders.containsKey(family.rootId))
    }
}
