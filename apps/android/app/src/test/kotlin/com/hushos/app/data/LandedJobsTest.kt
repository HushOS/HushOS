package com.hushos.app.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A job whose work landed after WorkManager stopped it must not run again (a duplicate upload), and must not take
 * the job queued behind it down with it: cancelling it did, for a keep queued with APPEND_OR_REPLACE.
 */
class LandedJobsTest {
    private val dir = Files.createTempDirectory("landed").toFile()

    @Test
    fun theRerunOfALandedJobDoesNothingAndTheKeepQueuedBehindItStillRuns() {
        val landed = LandedJobs(dir)
        // Keep A was stopped while its last file was finishing, and it landed; keep B is appended behind it.
        landed.mark("keep-a")
        assertTrue("A's rerun ends at once", landed.take("keep-a"))
        assertFalse("B runs as usual", landed.take("keep-b"))
        // Used up: a later run of A (should one ever be queued anew) is not skipped.
        assertFalse(landed.take("keep-a"))
    }

    /* A full disk (here, a mark's folder that can't be made) must not throw out of the worker's cleanup. */
    @Test
    fun aMarkThatCantBeWrittenSaysSoInsteadOfThrowing() {
        val blocked = File(dir, "not-a-folder").also { it.writeText("") }
        assertFalse(LandedJobs(blocked).mark("job"))
        assertFalse(LandedJobs(blocked).take("job"))
    }

    @Test
    fun aMarkNobodyTakesIsSweptAfterADay() {
        val landed = LandedJobs(dir)
        landed.mark("cancelled")
        landed.mark("fresh")
        File(dir, "cancelled").setLastModified(System.currentTimeMillis() - 25 * 60 * 60 * 1000L)
        landed.sweep()
        assertEquals(listOf("fresh"), dir.list()!!.toList())
    }
}
