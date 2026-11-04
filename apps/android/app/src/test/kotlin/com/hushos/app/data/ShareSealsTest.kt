package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * Which shares the re-seal pass seals again. The server records neither who sealed a share nor to which of the
 * grantee's keys, so a share missed here stays signed by a replaced identity or sealed to keys its grantee gave up;
 * one sealed again needlessly costs only a request. And a key replacement cut short must be finished by the pass,
 * not forgotten.
 */
class ShareSealsTest {
    private val current = 3uL
    private fun seal(granter: ULong, grantee: ULong?) = ShareSeals.Seal(granter, grantee)

    @Test
    fun aShareSealedNowByThisIdentityToThePinnedKeysIsLeftAlone() {
        assertFalse(needsReseal(4, seal(3uL, 2uL), current, 2uL))
        // A pin from before successions has no version to compare: left alone.
        assertFalse(needsReseal(4, seal(3uL, 2uL), current, null))
    }

    @Test
    fun anOlderSuiteAShareNeverRecordedOrOneSignedByAReplacedIdentityIsSealedAgain() {
        // Suite 3 (Ed25519 only) no longer opens anywhere: sealed again in suite 4, even when this device sealed it now.
        assertTrue(needsReseal(3, seal(3uL, 2uL), current, 2uL))
        assertTrue(needsReseal(2, seal(3uL, 2uL), current, 2uL))
        assertTrue(needsReseal(1, seal(3uL, 2uL), current, 2uL))
        assertTrue(needsReseal(4, null, current, 2uL))
        assertTrue(needsReseal(4, seal(2uL, 2uL), current, 2uL))
    }

    @Test
    fun aGranteeWhoseReplacedKeysThePersonCheckedAgainGetsTheShareSealedToTheNewOnes() {
        assertTrue(needsReseal(4, seal(3uL, 2uL), current, 3uL))
        assertTrue(needsReseal(4, seal(3uL, null), current, 1uL))
        // A pin at a lower version than the one sealed to is no reason (it never moves down).
        assertFalse(needsReseal(4, seal(3uL, 4uL), current, 3uL))
    }

    @Test
    fun recordsAndAWaitingReplacementSurviveARestartUntilThePassClearsIt() {
        val file = File(Files.createTempDirectory("seals").toFile(), ShareSeals.FILE)
        ShareSeals(file).apply {
            record(mapOf("s-1" to seal(3uL, 2uL), "s-2" to seal(3uL, null)))
            pending = 3uL
        }
        val again = ShareSeals(file)
        assertEquals(seal(3uL, 2uL), again.get("s-1"))
        assertEquals(seal(3uL, null), again.get("s-2"))
        assertNull(again.get("s-3"))
        assertEquals(3uL, again.pending)
        again.pending = null
        assertNull(ShareSeals(file).pending)
        assertEquals(seal(3uL, 2uL), ShareSeals(file).get("s-1"))
    }

    private val seals = ShareSeals(File(Files.createTempDirectory("seals").toFile(), ShareSeals.FILE))

    /*
     * The re-seal queue (ShareSeals.queue): a pass acknowledges only the requests it read before it began. A Continue that
     * queues someone again while an earlier pass for them is still running owes a new re-seal (to keys that pass never
     * saw), and that pass finishing must not erase it.
     */
    @Test
    fun aPassAcknowledgesOnlyTheRequestItReadNeverOneQueuedWhileItRan() {
        seals.queue("Grace")
        val read = seals.queued
        seals.queue("grace")
        seals.unqueue(read)
        assertTrue("grace" in seals.queued)
        // The next pass reads the newer request and acknowledges it.
        seals.unqueue(seals.queued)
        assertFalse("grace" in seals.queued)
    }

    @Test
    fun aRequestNobodyQueuedAgainIsAcknowledged() {
        seals.queue("grace")
        seals.queue("lee")
        seals.unqueue(seals.queued)
        assertFalse("grace" in seals.queued || "lee" in seals.queued)
    }
}
