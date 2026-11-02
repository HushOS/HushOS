package com.hushos.app.ui

import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilyWords
import com.hushos.app.data.checkCode
import com.hushos.app.data.checkMatch
import com.hushos.app.data.Opened
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.newPerson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/*
 * Round 6, items 1 and 3, through the real model, vault and FakeDrive: a family check that gets no answer keeps the marks
 * of the rows it keeps on screen, and a folder listing that opened its rows before a concurrent check found a fork shows
 * nothing of them after the fork's clear, which stays said.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamiliesModelRacesTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    private class Host(var vault: Vault?) : FamilyHost {
        override val currentVault: Vault? get() = vault
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        override fun item(id: String): Opened? = vault?.item(id)
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() = Unit
    }

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "families-model-races-test")
        family = FamilyFixture(server)
    }

    @After
    fun close() = server.close()

    private fun vault() = RuntimeEnvironment.getApplication().let { Vault(it, DriveApi(Shared.session(it)!!)) }

    private fun eventually(what: String, check: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (!check()) {
            if (System.currentTimeMillis() > until) throw AssertionError(what)
            Thread.sleep(20)
        }
    }

    /*
     * #247 check, round 8: They match reads the member list and the server answers not-member while the family guard
     * can't be read, so the removal can't finish. The family shows the failure with its storage words (the sheet's Try
     * again), never Wiped, and the device record stays. Fails if the sheet's removal is published as Wiped whatever the
     * wipe left.
     */
    @Test
    fun theyMatchMeetingARemovalWhoseWipeFailsShowsTheFailureNotWiped() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val vault = vault()
        val host = Host(vault)
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        val sam = com.hushos.app.data.FamilyMemberRef(family.creator.id, "sam@example.org", "Sam Lindqvist")
        family.notMember = true
        val folder = vault.familyGuard.file.parentFile!!
        val words = try {
            assertTrue(folder.setExecutable(false, false) && folder.setReadable(false, false))
            runBlocking {
                val session = model.begin()!!
                val failed = model.run(session) { it.checkMatch(family.groupId, sam, 2uL, List(12) { "word" }) }!!.exceptionOrNull()
                model.removedDuringCheck(failed as com.hushos.app.data.FamilyRemovedNow, family.summary, session)
            }
        } finally {
            folder.setExecutable(true, false)
            folder.setReadable(true, false)
        }
        val state = model.states[family.groupId]
        assertTrue("a removal whose wipe failed was shown as $state", state is FamilyState.Failed)
        assertEquals((state as FamilyState.Failed).words, words)
        assertTrue(vault.families.records.read(family.member.id, family.groupId) != null)
    }

    /*
     * #247 check, round 6: a share of the family's file is kept on this phone and listed on On this phone, its thumbnail
     * drawn, before the family's first sync proves its folder. After that sync, On this phone no longer lists it and its
     * thumbnail is gone. Fails if the screens keep a purged share's rows.
     */
    @Test
    fun onThisPhoneDropsAShareFileOnceItsFolderIsProven() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        server.shareWithMe(family.fileId)
        server.pinGrace()
        val app = RuntimeEnvironment.getApplication()
        val vault = vault()
        val root = vault.mountShares().single().root!!
        // This phone holds the account (a kept file is only this account's to keep).
        com.hushos.app.data.AccountStore.of(app).adopt(com.hushos.app.data.Shared.session(app)!!.userId)
        vault.keepDownloaded(root)
        val host = Host(vault)
        val thumb = "${family.fileId}@${root.node.currentVersion!!.id}"
        host.state.update { it.copy(offline = com.hushos.app.data.Offline.entries(app), thumbnails = it.thumbnails + (thumb to byteArrayOf(1))) }
        assertTrue(host.state.value.offline.any { it.id == family.fileId })
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        assertFalse("On this phone still lists a share's file in a folder proven a family's", host.state.value.offline.any { it.id == family.fileId })
        assertFalse(thumb in host.state.value.thumbnails)
    }

    /*
     * Someone outside the family wrote a file into the folder: its row is marked. The family's next check gets no answer;
     * the rows stay on screen, and so must the mark. Fails if an unanswered check drops the verdicts without judging again.
     */
    @Test
    fun aWarningSurvivesAnUnansweredRefresh() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val stranger = server.fileAs(newPerson(), family.rootId, "Note.txt", "not from the family".toByteArray())
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        runBlocking { model.refreshFolder(family.rootId) }
        val row = host.state.value.folders[family.rootId]!!.single { it.id == stranger }
        eventually("the row was never judged") { model.verdict(row) != null }
        val warned = model.verdict(row)!!
        assertNotNull("a file from outside the family carries no mark: $warned", warned.mark)
        // The connection drops before the server answers: no answer at all.
        server.beforeAnswer = { _, path -> if (path.startsWith("groups")) throw java.io.IOException("dropped") }
        runBlocking { model.refreshFamily(family.summary) }
        assertEquals(FamilyState.Failed(FamilyWords.NO_ANSWER, transient = true), model.states[family.groupId])
        assertTrue("the rows left the screen", host.state.value.folders.containsKey(family.rootId))
        assertEquals("the mark vanished on no answer", warned, model.verdict(row))
    }

    /*
     * Round 9, item 1 (the screen's side): the server replays older settings and the family's check is refused. Listing
     * its folder again neither shows its rows nor clears the refusal's words. Fails if a refusal leaves the folder listable.
     */
    @Test
    fun aRefusedFamilysFolderStaysRefused() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val older = server.settingsSnapshot()
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        runBlocking { model.refreshFolder(family.rootId) }
        assertTrue(host.state.value.folders.containsKey(family.rootId))
        server.editSettings { }
        host.vault!!.loadSettings()
        older()
        runBlocking { model.refreshFamily(family.summary) }
        val refused = model.states[family.groupId]
        assertTrue("$refused", refused is FamilyState.Failed && refused.words != FamilyWords.NO_ANSWER)
        val words = model.problems[family.rootId]
        assertNotNull(words)
        runBlocking { model.refreshFolder(family.rootId) }
        assertFalse("the refused family's rows came back", host.state.value.folders.containsKey(family.rootId))
        assertEquals("the refusal's words were cleared", words, model.problems[family.rootId])
    }

    /*
     * Round 10, item 1: a background check holds the family's turn when Check it's Sam starts; the member check waits
     * behind it, and its own sync then finds a fork. The background check shows Accepted first, and the member check's
     * fork, a later look, shows over it; an older Accepted then shows nothing. Fails if answers are ordered by when they
     * were asked for rather than by when they ran.
     */
    @Test
    fun aCheckQueuedBehindARefreshThatFindsAForkPublishesTheFork() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        val accepted = model.states[family.groupId] as FamilyState.Accepted
        val waiting = CountDownLatch(1)
        val release = CountDownLatch(1)
        val reads = java.util.concurrent.atomic.AtomicInteger()
        server.beforeAnswer = { method, path ->
            if (method == "GET" && path == "groups/${family.groupId}/rosters") {
                // The background check's read is held in its turn; the member check's, later, finds the fork.
                if (reads.incrementAndGet() == 1) { waiting.countDown(); release.await(10, TimeUnit.SECONDS) }
                else family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
            }
        }
        val refresh = kotlin.concurrent.thread { runBlocking { model.refreshFamily(family.summary) } }
        assertTrue(waiting.await(10, TimeUnit.SECONDS))
        val session = model.begin()!!
        var start: com.hushos.app.data.CheckStart? = null
        val check = kotlin.concurrent.thread { start = runBlocking { model.run<com.hushos.app.data.CheckStart>(session) { it.checkCode(family.summary, family.creator.id) } }?.getOrThrow() }
        Thread.sleep(300)
        release.countDown()
        refresh.join(10_000)
        check.join(10_000)
        // The check's sync met the fork, and a refusal any sync meets reaches the screens (FamilySync.takeRemovals): the
        // fork shows already, and the refresh's older acceptance, landing after it, never covers it.
        assertTrue("${model.states[family.groupId]}", model.states[family.groupId] is FamilyState.Fork)
        val found = start ?: throw AssertionError("the member check never finished")
        assertTrue("${found.state}", found.state is FamilyState.Fork)
        assertTrue("the fork found later was dropped", runBlocking { model.adopt(found.state, family.summary, session, found.revision) })
        assertTrue(model.states[family.groupId] is FamilyState.Fork)
        assertFalse("an older acceptance was shown over the fork", runBlocking { model.adopt(accepted, family.summary, session, found.revision!! - 1) })
        assertTrue(model.states[family.groupId] is FamilyState.Fork)
    }

    /*
     * Round 9, item 2: Check it's Sam's own sync answered Accepted, but a fork was shown before that answer landed. The
     * older answer publishes nothing over the fork. Fails if adopting a check's result ignores what was shown since.
     */
    @Test
    fun aCheckResultThatLandsAfterAForkPublishesNothing() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        val accepted = model.states[family.groupId] as FamilyState.Accepted
        val session = model.begin()!!
        // The check's own sync ran first (revision 1); the fork, found by a later sync, is on screen.
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        runBlocking { model.refreshFamily(family.summary) }
        assertTrue(model.states[family.groupId] is FamilyState.Fork)
        assertFalse("an older check result was shown", runBlocking { model.adopt(accepted, family.summary, session, 1L) })
        assertTrue("the fork was overwritten", model.states[family.groupId] is FamilyState.Fork)
        assertEquals(FamilyProblem.Words(FamilyWords.OPEN_AGAIN), model.problems[family.rootId])
    }

    /*
     * Round 16, item 1: Check it's Sam's sync accepted the family; then the families list no longer names it and the
     * server says not-member, so the list's reconcile wipes it. The check's Accepted, adopted only after, doesn't replace
     * Wiped. Fails if a removal found by the list publishes without a revision.
     */
    @Test
    fun aCheckResultAdoptedAfterAReconcileWipeDoesNotReplaceIt() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        val session = model.begin()!!
        val start = runBlocking { model.run<com.hushos.app.data.CheckStart>(session) { it.checkCode(family.summary, family.creator.id) } }!!.getOrThrow()
        assertTrue(start.state is FamilyState.Accepted)
        family.listed = false
        family.notMember = true
        runBlocking { model.refreshFamilies(force = true) }
        assertEquals(FamilyState.Wiped, model.states[family.groupId])
        assertFalse("an older check's Accepted was shown after the removal", runBlocking { model.adopt(start.state, family.summary, session, start.revision) })
        assertEquals(FamilyState.Wiped, model.states[family.groupId])
    }

    /*
     * Round 15, item 1: after a fork cleared the family, a redraw (a restore, a sync's relist) asks for the folders on
     * screen again. The family's folder goes through its family and brings nothing back; only the drive's own folders
     * are handed back to be listed plainly. Fails if a redraw lists and merges a family folder itself.
     */
    @Test
    fun aRedrawAfterAForkClearBringsNothingBack() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        runBlocking { model.refreshFolder(family.rootId) }
        assertTrue(host.state.value.folders.containsKey(family.rootId))
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        runBlocking { model.refreshFamily(family.summary) }
        assertTrue(model.states[family.groupId] is FamilyState.Fork)
        val words = model.problems[family.rootId]
        assertNotNull(words)
        val plain = runBlocking { model.relist(listOf(family.rootId, "personal-folder")) }
        assertEquals("a family folder was handed back to be listed plainly", listOf("personal-folder"), plain)
        assertFalse("the forked family's rows came back", host.state.value.folders.containsKey(family.rootId))
        assertEquals(words, model.problems[family.rootId])
    }

    /*
     * Round 11 review (a): two listings of one family folder overlap. The first opens the file under its old name and is
     * held; the file is renamed and a second listing shows the new name. The first then lands: it shows nothing, so the
     * newer row (and the verdict judged for it) stays. Fails if an older listing landing last puts back older rows.
     */
    @Test
    fun anOlderListingThatLandsLastShowsNothing() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        val executor = Executors.newSingleThreadExecutor()
        val stall = CountDownLatch(1)
        var held = false
        server.beforeAnswer = { method, path ->
            if (!held && method == "GET" && path == "drive/nodes/${family.rootId}/children") {
                held = true
                executor.execute { stall.await(10, TimeUnit.SECONDS) }
            }
        }
        val first = CoroutineScope(executor.asCoroutineDispatcher()).launch { model.refreshFolder(family.rootId) }
        eventually("the first listing never opened its rows") { host.vault?.item(family.fileId)?.name == "Recipes.txt" }
        server.beforeAnswer = null
        server.renameAs(family.fileId, "Recipes (Sam).txt")
        runBlocking { model.refreshFolder(family.rootId) }
        assertEquals(listOf("Recipes (Sam).txt"), host.state.value.folders[family.rootId]?.map { it.name })
        stall.countDown()
        runBlocking { first.join() }
        executor.shutdown()
        assertEquals("an older listing put back the old row", listOf("Recipes (Sam).txt"), host.state.value.folders[family.rootId]?.map { it.name })
    }

    /*
     * The folder's listing has opened its rows but not yet shown them when the family's check finds a fork and clears the
     * family. The listing then resumes: it shows nothing, and the fork's words stay in the folder. Fails if only a removal
     * stops a listing that began before the clear.
     */
    @Test
    fun aListingThatResumesAfterAForkClearPublishesNothing() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val host = Host(vault())
        val model = FamiliesModel(host)
        runBlocking { model.refreshFamilies() }
        assertTrue(model.states[family.groupId] is FamilyState.Accepted)
        // The listing's own thread, held once its rows are opened: what follows the listing waits behind `stall`.
        val executor = Executors.newSingleThreadExecutor()
        val stall = CountDownLatch(1)
        server.beforeAnswer = { method, path ->
            if (method == "GET" && path == "drive/nodes/${family.rootId}/children") executor.execute { stall.await(10, TimeUnit.SECONDS) }
        }
        val listing = CoroutineScope(executor.asCoroutineDispatcher()).launch { model.refreshFolder(family.rootId) }
        eventually("the listing never opened its rows") { host.vault?.item(family.fileId) != null }
        server.beforeAnswer = null
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        runBlocking { model.refreshFamily(family.summary) }
        assertTrue("${model.states[family.groupId]}", model.states[family.groupId] is FamilyState.Fork)
        assertEquals(FamilyProblem.Words(FamilyWords.OPEN_AGAIN), model.problems[family.rootId])
        stall.countDown()
        runBlocking { listing.join() }
        executor.shutdown()
        assertFalse("the fork's rows came back", host.state.value.folders.containsKey(family.rootId))
        assertEquals("the fork's words were cleared", FamilyProblem.Words(FamilyWords.OPEN_AGAIN), model.problems[family.rootId])
    }
}
