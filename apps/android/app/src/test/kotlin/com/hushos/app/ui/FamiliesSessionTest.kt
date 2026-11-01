package com.hushos.app.ui

import com.hushos.app.data.FamilyState
import com.hushos.app.data.NodeView
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.core.NodeMetadata
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/*
 * Family work belongs to the session it began in (round 2, item 1): an answer or a failure that lands after a sign-out or
 * an account switch changes nothing, so the next account never sees the last one's families and a late "signed out" never
 * signs it out. Plus the pure rules the screens use: Info on a family item stays open until its family is removed
 * (item 4), search never lists a row twice (item 5), and families are checked once a minute while open (item 8).
 */
class FamiliesSessionTest {
    private class Session

    /* A request held open until released, answering or failing then, on a thread of its own. */
    private fun <T> held(gate: SessionGate<Any>, block: () -> T): Pair<CountDownLatch, () -> Result<T>?> {
        val token = gate.begin()!!
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        var outcome: Result<T>? = null
        val done = CountDownLatch(1)
        thread { outcome = runBlocking { gate.run(token) { started.countDown(); release.await(5, TimeUnit.SECONDS); block() } }; done.countDown() }
        // In flight before the test moves on: what happens next happens while it is out.
        assertTrue(started.await(5, TimeUnit.SECONDS))
        return release to { assertTrue(done.await(5, TimeUnit.SECONDS)); outcome }
    }

    @Test
    fun anAnswerThatLandsAfterAResetChangesNothing() {
        val gate = SessionGate<Any> { "vault" }
        val (release, result) = held(gate) { "the old account's families" }
        gate.reset()
        release.countDown()
        assertNull(result())
    }

    @Test
    fun aSignedOutThatLandsAfterAResetIsNotTheNewSessions() {
        val gate = SessionGate<Any> { "vault" }
        val (release, result) = held(gate) { throw NotAuthenticated() }
        gate.reset()
        release.countDown()
        assertNull("a stale failure reached the caller", result())
    }

    @Test
    fun anAnswerForAnotherVaultIsDroppedAndTheCurrentOnesStands() {
        var current: Any = Session()
        val gate = SessionGate { current }
        val (release, result) = held(gate) { "old" }
        current = Session()
        release.countDown()
        assertNull(result())
        val now = gate.begin()!!
        assertEquals("new", runBlocking { gate.run(now) { "new" } }?.getOrNull())
        assertTrue(runBlocking { gate.run<String>(now) { throw NotAuthenticated() } }?.exceptionOrNull() is NotAuthenticated)
    }

    /*
     * Round 5, item 1: a step that runs after its operation's session ended (a nested refresh dropped its answer and
     * returned normally) never sends a request and never answers, even though a new session is signed in by then. Fails
     * if the gate checks whichever session is current at the inner call instead of the one the operation began in.
     */
    @Test
    fun aStepAfterTheSessionChangedSendsNothingForTheNewOne() {
        var current: Any = Session()
        val gate = SessionGate { current }
        val began = gate.begin()!!
        current = Session()
        var sent = false
        assertNull(runBlocking { gate.run(began) { sent = true; "the old vault's rows" } })
        assertNull(runBlocking { gate.run<String>(began) { sent = true; throw NotAuthenticated() } })
        assertFalse("a request went out for an ended session", sent)
        assertFalse(gate.current(began))
    }

    /*
     * Round 5, item 2: a judgement begun before a rejudge finishes after it. It doesn't publish, and the newer warning
     * stays; one begun before a trust change for every family is dropped the same way. Fails if a judgement publishes
     * whatever moved since it began.
     */
    @Test
    fun aStaleJudgementThatFinishesAfterARejudgeDoesNotPublish() {
        val verdicts = FamilyVerdicts { if (it == "area") "family" else null }
        val file = row("file")
        val stale = verdicts.capture("family")
        // The family's sync found a key conflict: judged again, and the newer judgement lands first.
        verdicts.moved("family")
        val fresh = verdicts.capture("family")
        assertTrue(verdicts.publish("family", fresh, listOf(file to WARNING)))
        assertFalse(verdicts.publish("family", stale, listOf(file to VERIFIED)))
        assertEquals(WARNING, verdicts.of(file))
        // A trust change for every family: what began before it is dropped too.
        verdicts.moved(null)
        assertFalse(verdicts.publish("family", fresh, listOf(file to VERIFIED)))
        assertNull(verdicts.of(file))
        // Another family's move leaves this family's judgement standing.
        val now = verdicts.capture("family")
        verdicts.moved("other")
        assertTrue(verdicts.publish("family", now, listOf(file to WARNING)))
    }

    /*
     * Round 11, item 1: two listings overlap and judge two versions of one file under the same trust. The newer version's
     * warning lands first; the older version's judgement lands last and is dropped, so the warning stays. Fails if
     * verdicts are kept by node alone.
     */
    @Test
    fun anOlderVersionsJudgementThatLandsLastDoesNotReplaceTheNewer() {
        val verdicts = FamilyVerdicts { if (it == "area") "family" else null }
        val older = versioned("file", 3, 1uL)
        val newer = versioned("file", 7, 2uL)
        val trust = verdicts.capture("family")
        assertTrue(verdicts.publish("family", trust, listOf(newer to WARNING)))
        verdicts.publish("family", trust, listOf(older to VERIFIED))
        assertEquals("the newer version's warning was replaced", WARNING, verdicts.of(newer))
        // A later version still replaces it.
        val later = versioned("file", 9, 3uL)
        verdicts.publish("family", trust, listOf(later to VERIFIED))
        assertEquals(VERIFIED, verdicts.of(later))
    }

    private fun versioned(id: String, changeSeq: Int, metadataVersion: ULong) =
        Opened(NodeView(id, "area", "root", "file", 1uL, 1uL, "", metadataVersion, "", null, null, null, null, changeSeq), NodeMetadata(id, null, null, null, emptyMap()))

    /*
     * Round 13, B: another member replaces a picture. The thumbnail held for the old version doesn't stand for the new
     * one: it is fetched again, and once it is held for the new version it isn't. Fails if thumbnails are held by item alone.
     */
    @Test
    fun aReplacedFilesThumbnailIsFetchedAgain() {
        val old = pictured("photo", "v1")
        val replaced = pictured("photo", "v2")
        val held = mapOf(thumbnailKey(old) to byteArrayOf(1))
        assertFalse(thumbnailDue(old, held))
        assertTrue("the old version's thumbnail stood for the new one", thumbnailDue(replaced, held))
        assertFalse(thumbnailDue(replaced, mapOf(thumbnailKey(replaced) to byteArrayOf(2))))
        assertEquals("photo", thumbnailItem(thumbnailKey(replaced)))
    }

    /*
     * Round 14, item 1: the row a tap opens is the vault's only when it is the same workspace's row of the same node and
     * not older; a personal file or a share with the same id never stands in. Fails if the row is looked up by id alone.
     */
    @Test
    fun aRowOfAnotherWorkspaceNeverStandsInForTheTappedOne() {
        val tapped = pictured("photo", "v1")
        val personal = tapped.copy(node = tapped.node.copy(workspaceId = "personal", changeSeq = 99))
        assertEquals(tapped, freshest(tapped, personal))
        val newer = tapped.copy(node = tapped.node.copy(changeSeq = 5, currentVersion = tapped.node.currentVersion!!.copy(id = "v2")))
        val older = tapped.copy(node = tapped.node.copy(changeSeq = 1))
        val asked = tapped.copy(node = tapped.node.copy(changeSeq = 3))
        assertEquals(newer, freshest(asked, newer))
        assertEquals(asked, freshest(asked, older))
        assertEquals(asked, freshest(asked, null))
    }

    private fun pictured(id: String, version: String) = Opened(
        NodeView(id, "area", "root", "file", 1uL, 1uL, "", 1uL, "", com.hushos.app.data.VersionView(version, "object-$version", "", "ready", 3u, 1, "", null), null, null, null),
        NodeMetadata(id, "image/jpeg", null, null, emptyMap()))

    @Test
    fun infoOnAFamilyItemStaysOpenUntilItsFamilyIsRemoved() {
        val own = "own"
        assertFalse(outOfReach("area", own, shares = emptyList(), family = true, familyState = FamilyState.Accepted(VIEW)))
        assertFalse(outOfReach("area", own, shares = emptyList(), family = true, familyState = null))
        assertTrue(outOfReach("area", own, shares = emptyList(), family = true, familyState = FamilyState.Wiped))
        // A share no longer listed still closes, as before.
        assertTrue(outOfReach("share", own, shares = emptyList(), family = false, familyState = null))
        assertFalse(outOfReach("share", own, shares = listOf("share"), family = false, familyState = null))
    }

    @Test
    fun searchListsEachRowOnce() {
        val file = row("file")
        val rows = searchableRows(listOf(file), mapOf("root" to listOf(file)), family = { true })
        assertEquals(listOf("file"), rows.map { it.id })
    }

    @Test
    fun familiesAreCheckedEveryMinuteWhileOpen() {
        // The last pass began on a tick and ended two seconds later: the next tick, a minute after the last, still checks.
        assertTrue(familiesDue(now = 60_000, syncedAt = 2_000, listed = true, force = false, maxAgeMs = FAMILY_TICK_AGE_MS))
        assertFalse(familiesDue(now = 20_000, syncedAt = 2_000, listed = true, force = false, maxAgeMs = FAMILY_TICK_AGE_MS))
        assertTrue(familiesDue(now = 20_000, syncedAt = 2_000, listed = false, force = false, maxAgeMs = FAMILY_TICK_AGE_MS))
    }

    private fun row(id: String) = Opened(NodeView(id, "area", "root", "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))

    private companion object {
        val VERIFIED = com.hushos.app.data.FamilyVerdict(null, null, null, emptyList(), "Verified by Lindqvist family")
        val WARNING = com.hushos.app.data.FamilyVerdict(com.hushos.app.data.FamilyVerdict.unchecked.mark, null, null, emptyList(), null)
        val VIEW = com.hushos.app.data.FamilyView("g", 1uL, "", 1uL, emptyList(), emptyList(), false, false, false, emptyList())
    }
}
