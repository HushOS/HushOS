package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A file that keeps failing inside a kept folder must not fail the folder on every sync:
 * it waits longer after each failure, the rest is kept, and Retry tries it now. A folder
 * kept out of a share goes when the share stops, and only then.
 */
class KeepRulesTest {
    private val now = 1_000_000_000L

    @Test
    fun aFailedFileWaitsLongerAfterEachFailure() {
        val first = KeepRules.failed(null, "f", "d", "Budget.xlsx", "Not found", now)
        assertEquals(1, first.attempts)
        assertEquals(now + KeepRules.FIRST_WAIT, first.nextAt)
        val second = KeepRules.failed(first, "f", "d", "Budget.xlsx", "Not found", now)
        assertEquals(now + 2 * KeepRules.FIRST_WAIT, second.nextAt)
        val third = KeepRules.failed(second, "f", "d", "Budget.xlsx", "Not found", now)
        assertEquals(now + 4 * KeepRules.FIRST_WAIT, third.nextAt)
    }

    @Test
    fun theWaitStopsGrowingAtItsLongest() {
        var failure: KeepFailure? = null
        repeat(40) { failure = KeepRules.failed(failure, "f", "d", "a", "x", now) }
        assertEquals(now + KeepRules.LONGEST_WAIT, failure!!.nextAt)
    }

    @Test
    fun aFileIsNotTriedAgainUntilItsWaitIsOver() {
        val failure = KeepRules.failed(null, "f", "d", "a", "x", now)
        assertFalse(KeepRules.due(failure, now))
        assertFalse(KeepRules.due(failure, failure.nextAt - 1))
        assertTrue(KeepRules.due(failure, failure.nextAt))
        assertTrue(KeepRules.due(null, now))
    }

    @Test
    fun retryTriesNowButAFurtherFailureStillWaitsLonger() {
        val twice = KeepRules.failed(KeepRules.failed(null, "f", "d", "a", "x", now), "f", "d", "a", "x", now)
        val retried = KeepRules.retryNow(twice)
        assertTrue(KeepRules.due(retried, now))
        assertEquals(now + 4 * KeepRules.FIRST_WAIT, KeepRules.failed(retried, "f", "d", "a", "x", now).nextAt)
    }

    @Test
    fun onlyTheNetworkOrTheSessionFailsTheWholeFolder() {
        assertTrue(KeepRules.failsTheJob(Unreachable()))
        assertTrue(KeepRules.failsTheJob(NotAuthenticated()))
        // A file the server refuses, or one that won't decrypt, is that file's problem alone.
        assertFalse(KeepRules.failsTheJob(ApiError(500, "The store returned no ETag")))
        assertFalse(KeepRules.failsTheJob(NotFound("This item no longer exists.")))
        assertFalse(KeepRules.failsTheJob(IllegalStateException("bad chunk")))
    }

    @Test
    fun theFolderRowSaysHowManyCouldNotBeKept() {
        assertNull(KeepRules.folderLine(0))
        assertEquals("1 file couldn’t be kept", KeepRules.folderLine(1))
        assertEquals("3 files couldn’t be kept", KeepRules.folderLine(3))
    }

    private val own = Offline.Folder("own", "Taxes", "2026-10-01T00:00:00Z", "ws-mine")
    private val shared = Offline.Folder("shared-sub", "Shared to mobile", "2026-10-01T00:00:00Z", "ws-owner", shareRoot = "share-root")

    @Test
    fun aStoppedShareTakesItsKeptFoldersWithIt() {
        assertEquals(listOf(shared), KeepRules.unshared(listOf(own, shared), receivedRoots = setOf("another-share")))
    }

    @Test
    fun aShareStillReceivedAndThisDrivesFoldersAreLeftAlone() {
        assertTrue(KeepRules.unshared(listOf(own, shared), receivedRoots = setOf("share-root")).isEmpty())
        // This drive's own kept folders never depend on shares, even when none are received.
        assertTrue(KeepRules.unshared(listOf(own), receivedRoots = emptySet()).isEmpty())
    }
}
