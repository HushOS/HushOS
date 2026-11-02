package com.hushos.app.data

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
import kotlin.concurrent.thread

/*
 * The member side of a removal (Android 4; the web's lib/groups/walks.ts and runRotation's family case) through the real
 * Vault, GroupsApi and the core's area ledger against FakeDrive: Sam's member list change re-keys the family folder's top
 * folder, and Maya's phone walks the rest to the new keys, in the foreground or in the background work with the app
 * closed, resuming after a stop mid-batch, and never under a chain it no longer trusts.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyWalksTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()
    /* A folder below the top folder with a file of its own: a walk two levels deep. */
    private lateinit var sub: String
    private lateinit var deep: String

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-walks-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        sub = server.folder(family.rootId, "Trips")
        deep = server.file(sub, "Packing.txt", "marker-deep".toByteArray())
        LiveVaults.app = null
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun accepted(phone: FamilyFixture.Phone): FamilyView =
        (phone.sync.sync(family.summary) as? FamilyState.Accepted)?.view ?: throw AssertionError("not accepted: ${phone.sync.sync(family.summary)}")

    /* A phone that opened the family and its folder before Sam changed the keys. */
    private fun opened(): FamilyFixture.Phone = family.phone().also { phone -> accepted(phone); phone.vault.listChildren(family.rootId, family.workspaceId) }

    /* What a phone of the account that never saw the folder before reads now, through its own ledger: every name and byte. */
    private fun readFresh(): Map<String, String> {
        val phone = family.phone()
        accepted(phone)
        val out = HashMap<String, String>()
        fun read(folder: String) {
            for (item in phone.vault.listChildren(folder, family.workspaceId)) {
                if (item.isFolder) { read(item.id); continue }
                val file = File(app.cacheDir, "read-${System.nanoTime()}/${item.name}")
                phone.vault.download(item.id, file, workspaceId = family.workspaceId)
                out[item.name] = file.readText()
            }
        }
        read(family.rootId)
        return out
    }

    private fun walkedEverything(target: Long = 100L) {
        assertFalse(server.running(family.rootId))
        for (id in listOf(family.fileId, sub, deep)) assertEquals("$id at the new keys", target, server.node(id).keyEpoch)
        assertEquals(mapOf("Recipes.txt" to "marker-family", "Packing.txt" to "marker-deep"), readFresh())
    }

    /*
     * Sam's key change runs; Maya's phone has its own reason to walk it (the top folder opened at the run's target under
     * the new key) and walks every node to the new keys, re-keyed records and all, which a fresh phone reads. A run that
     * re-keyed something other than the top folder is never walked on the server's word. Fails if the phone walks without
     * its own reason, or a node's records don't re-key under the fresh key its children are wrapped under.
     */
    @Test
    fun aMemberWalksTheKeyChangeItSawToItsEnd() {
        val phone = opened()
        family.replaceKeys()
        val area = accepted(phone).areas.single()
        assertTrue(area.rotating)
        val target = area.walkTarget()
        assertNotNull("the phone saw the top folder re-keyed at the target", target)
        // A run from anywhere else, or to another epoch, is no reason of this phone's.
        assertEquals(null, area.copy(rotation = area.rotation!!.copy(nodeId = sub)).walkTarget())
        assertEquals(null, area.copy(rotation = area.rotation!!.copy(targetEpoch = 99uL)).walkTarget())
        server.rotationBatch = 1
        assertEquals(WalkEnd.WALKED, phone.sync.walk(family.groupId, target!!))
        walkedEverything()
        // Nothing of the walk was left pending in the ledger.
        assertEquals(0u, phone.vault.areaLedger.rotateDropAll(family.workspaceId))
        // Asked again, it has ended: nothing more is sent.
        val sends = server.rotationBatches.size
        assertEquals(WalkEnd.ENDED_ELSEWHERE, phone.sync.walk(family.groupId, target))
        assertEquals(sends, server.rotationBatches.size)
    }

    /*
     * Two devices walk the same run, and the server judges each node on its own: Sam's device re-keys the subfolder just
     * before this phone's batch lands. The phone never sends the subfolder's child beside the subfolder, so nothing it
     * sends is sealed under a key the server refused: the child goes in a later batch, under the key Sam's device put
     * there, and every file reads afterwards. Fails if a child is sealed under its parent's pending key in the same batch
     * (the server then takes the child and refuses the parent, and the child is lost).
     */
    @Test
    fun aParentAnotherDeviceWinsNeverLeavesItsChildUnderAKeyNobodyKept() {
        val phone = opened()
        family.replaceKeys()
        val target = accepted(phone).areas.single().walkTarget()!!
        var raced = false
        server.beforeRotationSend = { ids ->
            if (!raced && sub in ids) {
                raced = true
                server.walkedElsewhere(family.rootId, sub, family.creator)
            }
        }
        assertEquals(WalkEnd.WALKED, phone.sync.walk(family.groupId, target))
        assertTrue("Sam's device won the subfolder", raced)
        // The child never went out beside its parent.
        assertFalse(server.rotationBatches.any { sub in it && deep in it })
        walkedEverything()
    }

    /*
     * The subfolder is in the trash, and Sam's device re-keyed it before this phone's process stopped: a fresh process
     * resumes with the subfolder's child still to do. The children route refuses a trashed folder, so the phone opens the
     * subfolder from the trash listing, at the key Sam's device gave it, and re-keys the child under it. Fails if a
     * trashed parent is only ever listed (every child then fails and the walk never ends).
     */
    @Test
    fun aResumeOverATrashedParentAnotherDeviceRekeyedFinishes() {
        val phone = opened()
        server.trash(sub)
        family.replaceKeys()
        server.walkedElsewhere(family.rootId, sub, family.creator)
        // A fresh process: a vault and ledger that never opened the subfolder at its new key.
        val next = family.phone(phone.folder)
        val target = accepted(next).areas.single().walkTarget()!!
        assertEquals(WalkEnd.WALKED, next.sync.walk(family.groupId, target))
        assertFalse(server.running(family.rootId))
        assertEquals(100L, server.node(deep).keyEpoch)
        // The child's key is wrapped under the key Sam's device gave the subfolder, so its record opens under it.
        assertEquals("Packing.txt", server.record(deep).name)
    }

    /*
     * A folder nested in the trashed subfolder, both re-keyed by Sam's device before this phone's process stopped: the
     * nested folder has no `trashedAt` of its own, so the trash listing doesn't name it and the children route refuses it.
     * A fresh process finds it, and the subfolder above it, in the folder's change feed and re-keys the nested file under
     * the key Sam's device gave the nested folder. Fails if only the trash listing is asked (the walk then never ends).
     */
    @Test
    fun aResumeUnderATrashedFolderFindsNestedParentsAnotherDeviceRekeyed() {
        val nested = server.folder(sub, "Day one")
        val file = server.file(nested, "Tickets.txt", "marker-nested".toByteArray())
        val phone = opened()
        server.trash(sub)
        family.replaceKeys()
        server.walkedElsewhere(family.rootId, sub, family.creator)
        server.walkedElsewhere(family.rootId, nested, family.creator)
        val next = family.phone(phone.folder)
        val target = accepted(next).areas.single().walkTarget()!!
        assertEquals(WalkEnd.WALKED, next.sync.walk(family.groupId, target))
        assertFalse(server.running(family.rootId))
        assertEquals(100L, server.node(file).keyEpoch)
        assertEquals("Tickets.txt", server.record(file).name)
        assertEquals("Packing.txt", server.record(deep).name)
    }

    /*
     * A batch that doesn't land (the connection drops) leaves no fresh key pending, so the same phone's next walk sends
     * those nodes again under keys of its own; and a batch that landed with its answer lost, then the process killed, is
     * finished by a fresh process that lists the re-keyed folder through its ledger. Fails if a stopped batch's keys stay
     * pending (the retry then refuses the node as walked already and never finishes).
     */
    @Test
    fun aWalkResumesAfterAStopMidBatch() {
        val phone = opened()
        family.replaceKeys()
        val target = accepted(phone).areas.single().walkTarget()!!
        server.rotationBatch = 1
        server.failRotationSends = setOf(2)
        val stopped = runCatching { phone.sync.walk(family.groupId, target) }.exceptionOrNull()
        assertNotNull("the second batch didn't land", stopped)
        assertEquals("nothing left pending", 0u, phone.vault.areaLedger.rotateDropAll(family.workspaceId))
        val unsent = server.rotationBatches[1].single()
        assertFalse(unsent in server.appliedIn(family.rootId))
        // Walked again by the same phone: the node that didn't land is sent again, and the walk ends.
        assertEquals(WalkEnd.WALKED, phone.sync.walk(family.groupId, target))
        assertEquals(2, server.rotationBatches.count { it == listOf(unsent) })
        walkedEverything()
    }

    @Test
    fun aWalkKilledAfterABatchLandedIsFinishedByTheNextProcess() {
        val phone = opened()
        family.replaceKeys()
        val target = accepted(phone).areas.single().walkTarget()!!
        server.rotationBatch = 1
        // The first batch (a folder) lands but its answer is lost; then the process dies.
        server.loseRotationAnswers = setOf(1)
        assertTrue(runCatching { phone.sync.walk(family.groupId, target) }.isFailure)
        val landed = server.rotationBatches[0].single()
        assertTrue(landed in server.appliedIn(family.rootId))
        // A new process: a fresh vault and ledger hold nothing of the walk and find the rest to do.
        val next = family.phone(phone.folder)
        val again = accepted(next).areas.single().walkTarget()!!
        assertEquals(WalkEnd.WALKED, next.sync.walk(family.groupId, again))
        assertFalse(server.rotationBatches.drop(1).any { landed in it })
        walkedEverything()
    }

    /*
     * A foreground sync lands while the walk's batch is on its way, and the server serves it an older member list (a
     * rollback): the phone refuses it, so the walk's batch is stopped at the final gate rather than sent under a chain the
     * phone no longer holds, its keys dropped, and the device record and the settings pin stay at the newer list. Once the
     * family checks out again, the walk finishes. Fails if a walk's send skips the final gate, or the older chain is
     * committed or written.
     */
    @Test
    fun aWalkRacingAForegroundAcceptanceNeverCommitsAnOlderChain() {
        val phone = opened()
        val newer = family.replaceKeys()
        val target = accepted(phone).areas.single().walkTarget()!!
        assertEquals(3uL, phone.records.read(family.member.id, family.groupId)?.rosterVersion)
        val pin = server.settings().groupPin(family.groupId)
        server.rotationBatch = 1
        var racing: FamilyState? = null
        phone.vault.beforeWriteGate = { _ ->
            if (racing == null) {
                family.chain = listOf(family.r1, family.r2)
                family.ignoringAfter = true
                thread { racing = phone.sync.sync(family.summary) }.join()
            }
        }
        val stopped = runCatching { phone.sync.walk(family.groupId, target) }.exceptionOrNull()
        assertTrue("$racing", racing is FamilyState.Failed)
        assertTrue("the batch was refused at the final gate: $stopped", stopped is FamilyFailure)
        assertEquals("no batch landed", setOf(family.rootId), server.appliedIn(family.rootId))
        assertEquals(0u, phone.vault.areaLedger.rotateDropAll(family.workspaceId))
        assertEquals(3uL, phone.records.read(family.member.id, family.groupId)?.rosterVersion)
        assertEquals(pin, server.settings().groupPin(family.groupId))
        // The server serves the family as it is again: accepted at the newer list, and the walk ends.
        phone.vault.beforeWriteGate = null
        family.chain = newer
        family.ignoringAfter = false
        assertEquals(3uL, accepted(phone).rosterVersion)
        assertEquals(WalkEnd.WALKED, phone.sync.walk(family.groupId, target))
        walkedEverything()
    }

    /*
     * Route 2 stops listing the family while the app is closed, and the roster request that would confirm the removal
     * gets no answer: the phone keeps the family's record and copies, so the background pass asks to run again rather
     * than calling it done (which would stop every later check). Once the server says not-member, the wipe happens and
     * the pass is done. Fails if a removal the server hasn't confirmed lets the background check go.
     */
    @Test
    fun anUnconfirmedRemovalKeepsTheBackgroundCheckGoing() {
        val app = Vault(this.app, DriveApi(Shared.session(this.app)!!))
        assertTrue(app.families.sync(family.summary) is FamilyState.Accepted)
        val records = FamilyRecords.of(this.app)
        var stopped = 0
        val pass = { FamilyWalkWork.run(this.app, Vault.fromShared(this.app)) { stopped++ } }
        family.listed = false
        family.rostersFail = true
        assertEquals(FamilyWalkWork.Outcome.RETRY, pass())
        assertEquals("the background check stays", 0, stopped)
        assertNotNull("kept until the server says", records.read(family.member.id, family.groupId))
        family.rostersFail = false
        family.notMember = true
        assertEquals(FamilyWalkWork.Outcome.DONE, pass())
        assertEquals(null, records.read(family.member.id, family.groupId))
        assertEquals("nothing left to check", 1, stopped)
    }

    /*
     * The app is closed (no live vault): Sam's key change is made meanwhile, and the background work's pass finds it with a
     * vault of its own, from the device record the app left, and walks it to its end; a pass whose walk stops asks to be
     * run again. Fails if the background pass doesn't walk, or calls a stopped walk done.
     */
    @Test
    fun aRemovalSeenWhileTheAppIsClosedIsWalkedByTheBackgroundWork() {
        // The app accepted the family once, under its own records, then closed.
        val app = Vault(this.app, DriveApi(Shared.session(this.app)!!))
        assertTrue(app.families.sync(family.summary) is FamilyState.Accepted)
        family.replaceKeys()
        server.rotationBatch = 1
        server.failRotationSends = setOf(1)
        assertEquals(FamilyWalkWork.Outcome.RETRY, FamilyWalkWork.run(this.app))
        assertTrue(server.running(family.rootId))
        assertEquals(FamilyWalkWork.Outcome.DONE, FamilyWalkWork.run(this.app))
        walkedEverything()
    }
}
